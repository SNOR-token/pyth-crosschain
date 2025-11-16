import 'dotenv/config';
import pino from 'pino';
import { Connection } from '@solana/web3.js';
import { parseKeypair } from './utils.js';
import { StateStore } from './stateStore.js';
import { SolendHelper } from './solend.js';
import { LiquidatorEngine } from './liquidatorEngine.js';

const {
  RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com',
  SOLEND_ENV = 'production',
  SOLEND_LIQ_API = 'https://api.solend.fi/v1/liquidate',
  HEALTH_THRESHOLD = '0.98',
  PRIMARY_SETTLEMENT_MINT = 'EPjFWdd5AufqSSqeM2q7dJ1WsQXy8G1S3DfS6kU4etQD',
  PRIMARY_SETTLEMENT_DECIMALS = '6',
  JUP_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote',
  JUP_SWAP_INSTRUCTIONS_URL = 'https://quote-api.jup.ag/v6/swap-instructions',
  JUP_DEFAULT_SLIPPAGE_BPS = '50',
  POLL_INTERVAL_MS = '15000',
  MAX_PARALLEL_TX = '1',
  UTILIZATION_BPS = '2000',
  MIN_REPAY_LAMPORTS = '0',
  MAX_REPAY_LAMPORTS,
  REPAY_ALLOW_LIST,
  STATE_FILE = '.liquidator-state.json',
  LIQUIDATOR_KEYPAIR,
} = process.env;

if (!LIQUIDATOR_KEYPAIR) {
  // eslint-disable-next-line no-console
  console.error('⚠️  Set LIQUIDATOR_KEYPAIR in your .env before running the bot.');
  process.exit(1);
}

const logger = pino({
  name: 'solend-liquidator',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  level: process.env.LOG_LEVEL || 'info',
});

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = parseKeypair(LIQUIDATOR_KEYPAIR);
const stateStore = new StateStore(STATE_FILE);
const helper = new SolendHelper({ connection, env: SOLEND_ENV, logger });

const engine = new LiquidatorEngine({
  connection,
  helper,
  wallet,
  stateStore,
  logger,
  opportunitiesApi: SOLEND_LIQ_API,
  settlementMint: PRIMARY_SETTLEMENT_MINT,
  settlementDecimals: Number(PRIMARY_SETTLEMENT_DECIMALS),
  config: {
    pollIntervalMs: Number(POLL_INTERVAL_MS),
    maxParallelTx: Number(MAX_PARALLEL_TX),
    healthThreshold: Number(HEALTH_THRESHOLD),
    utilizationBps: Number(UTILIZATION_BPS),
    minRepayLamports: BigInt(MIN_REPAY_LAMPORTS || 0),
    maxRepayLamports: MAX_REPAY_LAMPORTS ? BigInt(MAX_REPAY_LAMPORTS) : null,
    repayAllowList: REPAY_ALLOW_LIST ? REPAY_ALLOW_LIST.split(',').map((s) => s.trim()) : [PRIMARY_SETTLEMENT_MINT],
    jupiterQuoteUrl: JUP_QUOTE_URL,
    jupiterSwapUrl: JUP_SWAP_INSTRUCTIONS_URL,
    jupiterSlippageBps: Number(JUP_DEFAULT_SLIPPAGE_BPS),
  },
});

engine
  .start()
  .then(() => {
    logger.info({ wallet: wallet.publicKey.toBase58() }, 'Liquidator bot running');
  })
  .catch((err) => {
    logger.error({ err }, 'Failed to start liquidator bot');
    process.exit(1);
  });

const shutdown = (signal) => {
  logger.info({ signal }, 'Received shutdown signal');
  engine.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});
