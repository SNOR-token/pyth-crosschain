import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { fetchJupiterSwapInstructions } from '../jupiter.js';

export const createLiquidationRouter = ({ helper, connection, logger, config }) => {
  const router = express.Router();

  router.get('/opportunities', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 25;
      const list = await helper.fetchOpportunities({
        apiUrl: config.solendApi,
        limit,
        healthThreshold: config.healthThreshold,
      });
      res.json(list);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch opportunities');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/build-liquidation', async (req, res) => {
    try {
      const {
        obligationPubkey,
        liquidatorPubkey,
        repayAmountLamports,
        repayPct,
        repayReserve,
        collateralReserve,
        swapToMint,
        swapAmountLamports,
        swapSlippageBps,
      } = req.body || {};

      if (!obligationPubkey) return res.status(400).json({ error: 'missing obligationPubkey' });
      if (!liquidatorPubkey) return res.status(400).json({ error: 'missing liquidatorPubkey' });

      const liquidator = new PublicKey(liquidatorPubkey);
      const plan = await helper.buildLiquidationTransaction({
        obligationPubkey,
        liquidator,
        repayAmountLamports: repayAmountLamports ? BigInt(repayAmountLamports) : undefined,
        repayPct: repayPct ? Number(repayPct) : undefined,
        repayReserveHint: repayReserve,
        collateralReserveHint: collateralReserve,
      });

      const tx = plan.transaction;
      if (swapToMint && swapToMint !== plan.collateralMint.toBase58()) {
        const swapIxs = await fetchJupiterSwapInstructions({
          quoteUrl: config.jupiterQuoteUrl,
          swapUrl: config.jupiterSwapUrl,
          inputMint: plan.collateralMint.toBase58(),
          outputMint: swapToMint,
          amountRaw: (swapAmountLamports || plan.repayAmountLamports.toString()).toString(),
          slippageBps: swapSlippageBps || config.jupiterSlippageBps,
          userPublicKey: liquidatorPubkey,
        });
        swapIxs.forEach((ix) => tx.add(ix));
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = liquidator;

      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const unsignedTx = Buffer.from(serialized).toString('base64');
      res.json({
        unsignedTx,
        repayMint: plan.repayMint.toBase58(),
        collateralMint: plan.collateralMint.toBase58(),
        repayAmountLamports: plan.repayAmountLamports.toString(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to build liquidation transaction');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tx-submitted', (req, res) => {
    const { signature, obligationPubkey } = req.body || {};
    logger.info({ signature, obligationPubkey }, 'Client submitted signed transaction');
    res.json({ ok: true });
  });

  return router;
};

export default createLiquidationRouter;
