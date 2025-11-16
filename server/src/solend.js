import fetch from 'node-fetch';
import BigNumber from 'bignumber.js';
import { SolendAction, SolendMarket } from '@solendprotocol/solend-sdk';
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';

const normalizeOpportunity = (raw) => {
  const obligation = raw.obligationPubkey || raw.obligation || raw.pubkey;
  const borrower = raw.owner || raw.borrower;
  const healthFactor = Number(raw.healthFactor ?? raw.health ?? 0);
  const estProfitUsd = Number(
    raw.estimatedLiquidationBonusUsd ?? raw.estimatedProfitUsd ?? raw.estimatedProfitUsd24h ?? 0,
  );
  const repay = raw.maxRepay || raw.repay || raw.borrowMetadata || {};
  const collateral = raw.collateral?.largestPosition || raw.collateral || raw.collateralMetadata || {};
  return {
    obligationPubkey: obligation,
    borrower,
    healthFactor,
    estProfitUsd,
    repayMint: repay.mintAddress || repay.mint || repay.asset,
    repayReserve: repay.reserveAddress || repay.reserve,
    collateralMint: collateral.mintAddress || collateral.mint || collateral.asset,
    collateralReserve: collateral.reserveAddress || collateral.reserve,
    raw,
  };
};

const ensureAta = async (connection, owner, mint, payer) => {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (info) return { ata, ix: null };
  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
  };
};

export class SolendHelper {
  constructor({ connection, env = 'production', logger }) {
    this.connection = connection instanceof Connection ? connection : new Connection(connection, 'confirmed');
    this.env = env;
    this.logger = logger;
    this.marketPromise = null;
  }

  async getMarket() {
    if (!this.marketPromise) {
      this.marketPromise = SolendMarket.initialize(this.connection, 'mainnet-beta', this.env);
    }
    return this.marketPromise;
  }

  async fetchOpportunities({ apiUrl, limit = 20, healthThreshold = 0.98 }) {
    const resp = await fetch(`${apiUrl}?perPage=${limit}`);
    if (!resp.ok) throw new Error(`Solend API error ${resp.status}`);
    const payload = await resp.json();
    const list = (payload.results || payload || [])
      .map(normalizeOpportunity)
      .filter((item) => item.obligationPubkey && item.healthFactor && item.healthFactor < healthThreshold)
      .sort((a, b) => a.healthFactor - b.healthFactor || b.estProfitUsd - a.estProfitUsd);
    return list;
  }

  async fetchObligation(obligationPubkey) {
    const market = await this.getMarket();
    return market.fetchObligationByAddress(new PublicKey(obligationPubkey));
  }

  resolveReserve(reserves, targetAddress, obligationSideList) {
    if (targetAddress) {
      const pk = new PublicKey(targetAddress);
      const direct = reserves.find((reserve) => reserve.address.equals(pk));
      if (direct) return direct;
    }
    if (!obligationSideList?.length) return null;
    return reserves.find((reserve) =>
      obligationSideList.some((item) => item.reserve?.equals?.(reserve.address)),
    );
  }

  computeRepayAmount(borrowEntry, repayDecimals, repayAmountLamports, repayPct) {
    const wadToLamportsFactor = new BigNumber(10).pow(18 - repayDecimals);
    const borrowedLamports = borrowEntry.borrowedAmountWads
      .dividedBy(wadToLamportsFactor)
      .integerValue(BigNumber.ROUND_DOWN);
    const borrowedBigInt = BigInt(borrowedLamports.toFixed(0));
    if (repayAmountLamports) {
      const desired = BigInt(repayAmountLamports);
      return desired > borrowedBigInt ? borrowedBigInt : desired;
    }
    const pct = repayPct > 0 && repayPct <= 1 ? repayPct : 0.25;
    const pctScaled = BigInt(Math.floor(pct * 1000));
    const computed = (borrowedBigInt * pctScaled) / 1000n;
    return computed > borrowedBigInt ? borrowedBigInt : computed;
  }

  async buildLiquidationTransaction({
    obligationPubkey,
    liquidator,
    repayAmountLamports,
    repayPct = 0.25,
    repayReserveHint,
    collateralReserveHint,
    prependInstructions = [],
    appendInstructions = [],
    requireAtaSetup = true,
  }) {
    if (!obligationPubkey) throw new Error('Missing obligationPubkey');
    if (!liquidator) throw new Error('Missing liquidator public key');

    const obligation = await this.fetchObligation(obligationPubkey);
    if (!obligation) throw new Error('Obligation not found');

    const market = await this.getMarket();
    const repayReserve = this.resolveReserve(
      market.reserves,
      repayReserveHint,
      obligation.info?.borrows || obligation.borrows,
    );
    if (!repayReserve) throw new Error('Unable to resolve repay reserve');

    const collateralReserve = this.resolveReserve(
      market.reserves,
      collateralReserveHint,
      obligation.info?.deposits || obligation.deposits,
    );
    if (!collateralReserve) throw new Error('Unable to resolve collateral reserve');

    const repayMint = repayReserve.config.liquidityToken.mint;
    const collateralMint = collateralReserve.config.liquidityToken.mint;
    const repayDecimals = repayReserve.config.liquidityToken.decimals;
    const collateralDecimals = collateralReserve.config.liquidityToken.decimals;

    const borrowEntry = (obligation.info?.borrows || obligation.borrows || []).find((borrow) =>
      borrow.reserve?.equals?.(repayReserve.address),
    );
    if (!borrowEntry) throw new Error('Borrow leg not found for repay reserve');

    const desiredRepay = this.computeRepayAmount(borrowEntry, repayDecimals, repayAmountLamports, repayPct);
    if (desiredRepay <= 0n) throw new Error('Repay amount too small');

    const transaction = new Transaction();
    const setupIxs = [];
    const cleanupIxs = [];

    const ensure = async (mint) => ensureAta(this.connection, liquidator, new PublicKey(mint), liquidator);
    let repayAta;
    let collateralAta;

    if (requireAtaSetup) {
      const repayAtaResult = await ensure(repayMint);
      repayAta = repayAtaResult.ata;
      if (repayAtaResult.ix) setupIxs.push(repayAtaResult.ix);

      const colAtaResult = await ensure(collateralMint);
      collateralAta = colAtaResult.ata;
      if (colAtaResult.ix) setupIxs.push(colAtaResult.ix);
    } else {
      repayAta = await getAssociatedTokenAddress(new PublicKey(repayMint), liquidator, true);
      collateralAta = await getAssociatedTokenAddress(new PublicKey(collateralMint), liquidator, true);
    }

    const action = await SolendAction.buildLiquidateTxns(this.connection, {
      obligationPubkey: new PublicKey(obligationPubkey),
      repayAmount: desiredRepay,
      repayMint: new PublicKey(repayMint),
      repaySourceTokenAccount: repayAta,
      userCollateralAccount: collateralAta,
      liquidator,
      marketAddress: obligation.info?.lendingMarket || obligation.lendingMarket,
      env: this.env,
    });

    [...prependInstructions, ...setupIxs, ...(action.instructions || [])].forEach((ix) => transaction.add(ix));
    [...(action.cleanupInstructions || []), ...cleanupIxs, ...appendInstructions].forEach((ix) => transaction.add(ix));

    return {
      transaction,
      repayMint: new PublicKey(repayMint),
      collateralMint: new PublicKey(collateralMint),
      repayDecimals,
      collateralDecimals,
      repayAmountLamports: desiredRepay,
      signers: action.signers || [],
      repayAta,
      collateralAta,
      obligation,
    };
  }
}
