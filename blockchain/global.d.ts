declare module '@solana/web3.js' {
  export class PublicKey {
    constructor(value: string | Uint8Array | Array<number>);
    toBase58(): string;
  }

  export class Keypair {
    publicKey: PublicKey;
    static fromSecretKey(secretKey: Uint8Array): Keypair;
  }

  export class Connection {
    constructor(endpoint: string, commitmentOrConfig?: any);
    getBalance(pubkey: PublicKey): Promise<number>;
  }

  export const SystemProgram: any;
  export class Transaction {
    add(...args: any[]): this;
  }

  export function sendAndConfirmTransaction(
    connection: Connection,
    transaction: Transaction,
    signers: Keypair[]
  ): Promise<string>;
}
declare module 'bs58';
declare module 'node-fetch';
declare module 'node-cron';

declare const process: {
  env: {
    [key: string]: string | undefined;
  };
};
