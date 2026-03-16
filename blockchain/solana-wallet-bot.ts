import 'dotenv/config';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.RPC_URL!;
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const SOLANA_PRIVATE_KEYS = process.env.SOLANA_PRIVATE_KEYS;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;
const SWEEP_TO_ADDRESS = process.env.SWEEP_TO_ADDRESS;

if (!RPC_URL || !DISCORD_WEBHOOK_URL) {
  throw new Error('Missing RPC_URL or DISCORD_WEBHOOK_URL in .env');
}

const privateKeyStrings: string[] = (() => {
  if (SOLANA_PRIVATE_KEYS && SOLANA_PRIVATE_KEYS.trim().length > 0) {
    return SOLANA_PRIVATE_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (SOLANA_PRIVATE_KEY && SOLANA_PRIVATE_KEY.trim().length > 0) {
    return [SOLANA_PRIVATE_KEY.trim()];
  }
  throw new Error(
    'You must set either SOLANA_PRIVATE_KEY or SOLANA_PRIVATE_KEYS in .env'
  );
})();

type JobConfig = {
  name?: string;
  cron: string;
  toAddress: string;
  amountSol: number;
  enabled?: boolean;
};

type Wallet = {
  keypair: Keypair;
  label: string;
};

const connection = new Connection(RPC_URL, 'confirmed');

const wallets: Wallet[] = privateKeyStrings.map((raw, index) => {
  const secretKey = bs58.decode(raw);
  const keypair = Keypair.fromSecretKey(secretKey);
  return {
    keypair,
    label: `wallet-${index + 1}`,
  };
});

async function sendDiscordMessage(content: string) {
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

async function getBalanceSOL(pubkey: PublicKey) {
  const lamports = await connection.getBalance(pubkey);
  return lamports / 1_000_000_000; // 1 SOL = 1e9 lamports
}

async function sendSol(
  from: Keypair,
  toAddress: string,
  amountSol: number
) {
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.round(amountSol * 1_000_000_000);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey,
      lamports,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [from]);
  return signature;
}

function loadJobConfigs(): JobConfig[] {
  const jobsPath = path.join(__dirname, 'jobs.json');

  if (!fs.existsSync(jobsPath)) {
    // No jobs file at all -> no scheduled jobs
    return [];
  }

  try {
    const raw = fs.readFileSync(jobsPath, 'utf8').trim();
    if (!raw) {
      // Empty file -> treat as "no jobs"
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('jobs.json root is not an array; ignoring jobs.');
      return [];
    }
    return parsed;
  } catch (err) {
    console.warn(
      'Failed to read/parse jobs.json; ignoring jobs:',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

async function runJob(job: JobConfig, wallet: Wallet) {
  try {
    const balance = await getBalanceSOL(wallet.keypair.publicKey);
    const label = job.name ?? 'unnamed job';
    await sendDiscordMessage(
      `Job "${label}" started on ${wallet.label}. Wallet: ${wallet.keypair.publicKey.toBase58()}, balance: ${balance} SOL. Sending ${job.amountSol} SOL to ${job.toAddress}.`
    );

    const sig = await sendSol(wallet.keypair, job.toAddress, job.amountSol);

    const explorerUrl = `https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`;
    await sendDiscordMessage(
      `Job "${label}" complete. Tx signature: ${sig}\nExplorer: ${explorerUrl}`
    );
  } catch (err: any) {
    await sendDiscordMessage(
      `Job "${job.name ?? 'unnamed job'}" failed: ${
        err?.message ?? String(err)
      }`
    );
  }
}

async function main() {
  for (const wallet of wallets) {
    const balance = await getBalanceSOL(wallet.keypair.publicKey);
    console.log(
      `[${wallet.label}] Wallet address: ${wallet.keypair.publicKey.toBase58()}`
    );
    console.log(`[${wallet.label}] Balance: ${balance} SOL`);
  }

  const jobs = loadJobConfigs().filter((job) => job.enabled !== false);

  if (jobs.length === 0) {
    console.log('No enabled jobs found in jobs.json; nothing to schedule.');
  } else {
    for (const wallet of wallets) {
      for (const job of jobs) {
        const label = job.name ?? 'unnamed job';
        cron.schedule(job.cron, () => {
          void runJob(job, wallet);
        });
        console.log(
          `[${wallet.label}] Scheduled job "${label}" to send ${
            job.amountSol
          } SOL to ${job.toAddress} with cron "${job.cron}".`
        );
      }
    }

    console.log('Automation jobs scheduled.');
  }

  if (SWEEP_TO_ADDRESS) {
    const feeBufferLamports = 10_000; // small buffer to keep account alive and cover fees

    for (const wallet of wallets) {
      let lastLamports: number | null = null;

      // Initialize lastLamports with current balance for this wallet
      try {
        const current = await connection.getBalance(wallet.keypair.publicKey);
        lastLamports = current;
        console.log(
          `[${wallet.label}] Auto-sweep watcher initial balance: ${
            current / 1_000_000_000
          } SOL`
        );
      } catch (err) {
        console.error(
          `[${wallet.label}] Failed to fetch initial balance for auto-sweep:`,
          err
        );
      }

      // Polling loop per wallet
      setInterval(async () => {
        try {
          const current = await connection.getBalance(wallet.keypair.publicKey);

          if (lastLamports === null) {
            lastLamports = current;
            return;
          }

          if (current > lastLamports) {
            const deltaLamports = current - lastLamports;
            const sweepableLamports = Math.max(
              0,
              current - feeBufferLamports
            );

            if (sweepableLamports > 0) {
              const amountSol = sweepableLamports / 1_000_000_000;

              try {
                await sendDiscordMessage(
                  `[${wallet.label}] Detected incoming SOL (+${
                    deltaLamports / 1_000_000_000
                  } SOL). Sweeping approximately ${amountSol} SOL to ${SWEEP_TO_ADDRESS}.`
                );

                const sig = await sendSol(
                  wallet.keypair,
                  SWEEP_TO_ADDRESS,
                  amountSol
                );
                const explorerUrl = `https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`;

                await sendDiscordMessage(
                  `[${wallet.label}] Auto-sweep complete. Tx signature: ${sig}\nExplorer: ${explorerUrl}`
                );
              } catch (err: any) {
                await sendDiscordMessage(
                  `[${wallet.label}] Auto-sweep failed: ${
                    err?.message ?? String(err)
                  }`
                );
              }
            }
          }

          lastLamports = current;
        } catch (err) {
          console.error(
            `[${wallet.label}] Error while polling for auto-sweep:`,
            err
          );
        }
      }, 5_000); // check every 5 seconds

      console.log(
        `[${wallet.label}] Auto-sweep enabled to ${SWEEP_TO_ADDRESS} (polling every 5 seconds).`
      );
    }
  } else {
    console.log(
      'Auto-sweep disabled: set SWEEP_TO_ADDRESS in .env to enable.'
    );
  }
}

main().catch(console.error);