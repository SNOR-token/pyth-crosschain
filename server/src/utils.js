import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs/promises';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const parseKeypair = (raw) => {
  if (!raw) throw new Error('Missing LIQUIDATOR_KEYPAIR env');
  try {
    if (raw.trim().startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch (err) {
    throw new Error(`Failed to parse LIQUIDATOR_KEYPAIR: ${err.message}`);
  }
};

export const loadJson = async (path, fallback) => {
  try {
    const buf = await fs.readFile(path, 'utf-8');
    return JSON.parse(buf);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

export const saveJson = async (path, data) => {
  await fs.writeFile(path, JSON.stringify(data, null, 2));
};

export const formatLamports = (lamports, decimals = 6) => {
  const bn = typeof lamports === 'bigint' ? lamports : BigInt(lamports ?? 0);
  return Number(bn) / 10 ** decimals;
};

export const toPublicKey = (value, label) => {
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new Error(`Invalid public key for ${label}: ${value}`);
  }
};
