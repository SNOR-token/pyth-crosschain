import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Connection } from '@solana/web3.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseKeypair } from './utils.js';
import { StateStore } from './stateStore.js';
import { SolendHelper } from './solend.js';
import { LiquidatorEngine } from './liquidatorEngine.js';
import createLiquidationRouter from './routes/liquidation.js';

const {
  PORT = 4000,
  RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com',
  SOLEND_ENV = 'production',
  SOLEND_LIQ_API = 'https://api.solend.fi/v1/liquidate',
  HEALTH_THRESHOLD = '0.98',
  PRIMARY_SETTLEMENT_MINT = 'EPjFWdd5AufqSSqeM2q7dJ1WsQXy8G1S3DfS6kU4etQD', // USDC
  PRIMARY_SETTLEMENT_DECIMALS = '6',
  JUP_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote',
  JUP_SWAP_INSTRUCTIONS_URL = 'https://quote-api.jup.ag/v6/swap-instructions',
  JUP_DEFAULT_SLIPPAGE_BPS = '50',
  POLL_INTERVAL_MS = '15000',
  MAX_PARALLEL_TX = '1',
  STATE_FILE = '.liquidator-state.json',
  LIQUIDATOR_KEYPAIR,
  AUTO_LIQUIDATE = 'true',
} = process.env;

const logger = pino({
  name: 'solend-liquidator',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
  level: process.env.LOG_LEVEL || 'info',
});

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = parseKeypair(LIQUIDATOR_KEYPAIR);
const stateStore = new StateStore(STATE_FILE);
const helper = new SolendHelper({ connection, env: SOLEND_ENV, logger });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(pinoHttp({ logger }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const router = createLiquidationRouter({
  helper,
  connection,
  logger,
  config: {
    solendApi: SOLEND_LIQ_API,
    healthThreshold: Number(HEALTH_THRESHOLD),
    jupiterQuoteUrl: JUP_QUOTE_URL,
    jupiterSwapUrl: JUP_SWAP_INSTRUCTIONS_URL,
    jupiterSlippageBps: Number(JUP_DEFAULT_SLIPPAGE_BPS),
  },
});
app.use('/api', router);

app.get('/api/bot/state', (req, res) => {
  res.json({ ...stateStore.snapshot(), wallet: wallet.publicKey.toBase58() });
});

let engine = null;
if (AUTO_LIQUIDATE !== 'false') {
  engine = new LiquidatorEngine({
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
      utilizationBps: Number(process.env.UTILIZATION_BPS || 6000),
      minRepayLamports: BigInt(process.env.MIN_REPAY_LAMPORTS || 0),
      maxRepayLamports: process.env.MAX_REPAY_LAMPORTS ? BigInt(process.env.MAX_REPAY_LAMPORTS) : null,
      repayAllowList: process.env.REPAY_ALLOW_LIST
        ? process.env.REPAY_ALLOW_LIST.split(',').map((s) => s.trim())
        : [PRIMARY_SETTLEMENT_MINT],
      jupiterQuoteUrl: JUP_QUOTE_URL,
      jupiterSwapUrl: JUP_SWAP_INSTRUCTIONS_URL,
      jupiterSlippageBps: Number(JUP_DEFAULT_SLIPPAGE_BPS),
    },
  });
  engine.start().catch((err) => {
    logger.error({ err }, 'Failed to start liquidator engine');
  });
}

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'HTTP server listening');
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down');
  engine?.stop();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down');
  engine?.stop();
  server.close(() => process.exit(0));
});
