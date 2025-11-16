import fetch from 'node-fetch';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const fetchJupiterSwapInstructions = async ({
  quoteUrl,
  swapUrl,
  inputMint,
  outputMint,
  amountRaw,
  slippageBps,
  userPublicKey,
  wrapAndUnwrapSol = true,
}) => {
  const quoteEndpoint = `${quoteUrl}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&swapMode=ExactIn`;
  const quoteResp = await fetch(quoteEndpoint);
  if (!quoteResp.ok) throw new Error(`Jupiter quote failed with status ${quoteResp.status}`);

  const quoteJson = await quoteResp.json();
  const route = quoteJson.data?.[0];
  if (!route) throw new Error('Jupiter quote did not return any routes');

  const swapResp = await fetch(swapUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: route,
      userPublicKey,
      wrapAndUnwrapSol,
      useSharedAccounts: true,
    }),
  });
  if (!swapResp.ok) throw new Error(`Jupiter swap-instructions failed with status ${swapResp.status}`);

  const swapJson = await swapResp.json();
  const instructions = [];
  const decodeIx = (ix) =>
    new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: Buffer.from(ix.data, 'base64'),
    });

  (swapJson.setupInstructions || []).forEach((ix) => instructions.push(decodeIx(ix)));
  if (swapJson.swapInstruction) instructions.push(decodeIx(swapJson.swapInstruction));
  (swapJson.cleanupInstructions || []).forEach((ix) => instructions.push(decodeIx(ix)));
  return instructions;
};
