import { Transaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { fetchJupiterSwapInstructions } from './jupiter.js';

const DEFAULTS = {
  pollIntervalMs: 15000,
  healthThreshold: 0.98,
  maxParallelTx: 1,
  utilizationBps: 6000,
  minRepayLamports: 0n,
  maxRepayLamports: null,
  repayAllowList: [],
  jupiterSlippageBps: 50,
};

export class LiquidatorEngine {
  constructor({
    connection,
    helper,
    wallet,
    stateStore,
    logger,
    opportunitiesApi,
    settlementMint,
    settlementDecimals = 6,
    config = {},
  }) {
    this.connection = connection;
    this.helper = helper;
    this.wallet = wallet;
    this.stateStore = stateStore;
    this.logger = logger;
    this.opportunitiesApi = opportunitiesApi;
    this.settlementMint = new PublicKey(settlementMint);
    this.settlementDecimals = settlementDecimals;
    this.config = { ...DEFAULTS, ...config };
    this.running = false;
    this.timer = null;
    this.inFlight = 0;
    this.settlementAta = null;
  }

  async start() {
    if (this.running) return;
    await this.stateStore.load();
    await this.refreshSettlementBalance();
    this.running = true;
    this.scheduleNext();
    this.logger.info({ wallet: this.wallet.publicKey.toBase58() }, 'Liquidator engine started');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.logger.info('Liquidator engine stopped');
  }

  scheduleNext() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.logger.error({ err }, 'Liquidator tick failed'));
    }, this.config.pollIntervalMs);
  }

  async tick() {
    if (!this.running) return;
    if (this.inFlight >= this.config.maxParallelTx) {
      this.logger.warn('Max parallel transactions in progress, skipping tick');
      this.scheduleNext();
      return;
    }
    this.inFlight += 1;
    try {
      await this.stateStore.patch((state) => ({ ...state, cycles: state.cycles + 1 }));
      await this.runCycle();
    } finally {
      this.inFlight -= 1;
      this.scheduleNext();
    }
  }

  async runCycle() {
    const opportunities = await this.helper.fetchOpportunities({
      apiUrl: this.opportunitiesApi,
      limit: 50,
      healthThreshold: this.config.healthThreshold,
    });
    const candidate = this.pickCandidate(opportunities);
    if (!candidate) {
      this.logger.debug('No eligible liquidation opportunities');
      return;
    }

    const availableCapital = await this.refreshSettlementBalance();
    const repayLamports = this.computeDynamicRepay(availableCapital);
    if (repayLamports <= 0n) {
      this.logger.warn('No settlement capital available, skipping liquidation');
      return;
    }

    this.logger.info(
      {
        obligation: candidate.obligationPubkey,
        health: candidate.healthFactor,
        repayLamports: repayLamports.toString(),
      },
      'Attempting liquidation',
    );

    try {
      const { transaction, collateralMint, signers, repayAmountLamports } = await this.helper.buildLiquidationTransaction(
        {
          obligationPubkey: candidate.obligationPubkey,
          liquidator: this.wallet.publicKey,
          repayAmountLamports: repayLamports,
          repayReserveHint: candidate.repayReserve,
          collateralReserveHint: candidate.collateralReserve,
        },
      );

      await this.sendAndConfirm(transaction, signers);
      await this.stateStore.patch((state) => ({
        ...state,
        totalLiquidations: state.totalLiquidations + 1,
        lastError: null,
      }));
      this.logger.info('Liquidation confirmed, harvesting collateral');

      const swapSig = await this.harvestAndCompound(collateralMint);
      if (swapSig) this.logger.info({ swapSig }, 'Collateral swapped back to settlement mint');

      await this.refreshSettlementBalance();
    } catch (err) {
      await this.stateStore.patch((state) => ({
        ...state,
        totalFailed: state.totalFailed + 1,
        lastError: err.message,
      }));
      this.logger.error({ err }, 'Liquidation execution failed');
    }
  }

  pickCandidate(opportunities) {
    const allowList = this.config.repayAllowList?.length ? this.config.repayAllowList : [this.settlementMint.toBase58()];
    return opportunities.find((opp) => allowList.includes((opp.repayMint || '').toString()));
  }

  computeDynamicRepay(availableLamports) {
    if (availableLamports <= 0n) return 0n;
    const utilization = this.config.utilizationBps;
    let target = (availableLamports * BigInt(utilization)) / 10000n;
    if (this.config.maxRepayLamports) {
      const max = BigInt(this.config.maxRepayLamports);
      if (target > max) target = max;
    }
    if (target < this.config.minRepayLamports) return 0n;
    return target;
  }

  async refreshSettlementBalance() {
    if (!this.settlementAta) {
      this.settlementAta = await getAssociatedTokenAddress(this.settlementMint, this.wallet.publicKey, true);
    }
    const info = await this.connection.getTokenAccountBalance(this.settlementAta).catch(() => null);
    const lamports = info ? BigInt(info.value.amount) : 0n;
    await this.stateStore.patch((state) => ({
      ...state,
      settledLamports: lamports.toString(),
    }));
    return lamports;
  }

  async harvestAndCompound(collateralMint) {
    if (!collateralMint) return null;
    const collateralPk = new PublicKey(collateralMint);
    if (collateralPk.equals(this.settlementMint)) return null;

    const ata = await getAssociatedTokenAddress(collateralPk, this.wallet.publicKey, true);
    const info = await this.connection.getTokenAccountBalance(ata).catch(() => null);
    const amountRaw = info ? info.value.amount : null;
    if (!amountRaw || amountRaw === '0') return null;

    const swapIxs = await fetchJupiterSwapInstructions({
      quoteUrl: this.config.jupiterQuoteUrl,
      swapUrl: this.config.jupiterSwapUrl,
      inputMint: collateralPk.toBase58(),
      outputMint: this.settlementMint.toBase58(),
      amountRaw,
      slippageBps: this.config.jupiterSlippageBps,
      userPublicKey: this.wallet.publicKey.toBase58(),
    });

    const tx = new Transaction();
    swapIxs.forEach((ix) => tx.add(ix));
    return this.sendAndConfirm(tx, []);
  }

  async sendAndConfirm(transaction, extraSigners = []) {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = this.wallet.publicKey;

    (extraSigners || []).forEach((kp) => {
      if (kp?.secretKey) transaction.partialSign(kp);
    });
    transaction.sign(this.wallet);

    const raw = transaction.serialize();
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false });
    await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    await this.stateStore.patch((state) => ({ ...state, lastSignature: signature }));
    return signature;
  }
}
