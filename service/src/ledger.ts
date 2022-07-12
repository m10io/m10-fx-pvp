import { LedgerClient } from 'm10-sdk/out/client';
import { CryptoSigner } from 'm10-sdk/out/utils';
import { m10 } from 'm10-sdk/protobufs';
import { Logger } from 'tslog';

type TransferCallback = (contextId: Uint8Array, txId: Long, transfer: m10.sdk.transaction.ICreateTransfer) => Promise<void>;
type IFindTransfer = {
  contextId?: Uint8Array;
  txId?: Long;
};

class M10Ledger {
  private log: Logger;
  private client: LedgerClient;
  private accountId: String;
  private keyPair: CryptoSigner;
  private service?: m10.sdk.M10QueryService;
  id: String;

  constructor(id: string, url: string, accountId: string, keyPair: string) {
    this.log = new Logger({ name: `ledger=${id}` });
    this.client = new LedgerClient(url, true);
    this.accountId = accountId;
    // NOTE @sadroeck - Prefer to sign via an external vault (e.g. Vault/aws-KMS/..). Fine for demo
    this.keyPair = CryptoSigner.getSignerFromPkcs8V2(keyPair);
    this.id = id;

    this.log.info(`Connecting to M10 ledger id=${this.id} accountId=${this.accountId} publicKey=${this.keyPair.getPublicKey().toString('base64')}`);
  }

  publicKey(): Buffer {
    return this.keyPair.getPublicKey();
  }

  async findTransfers(req: IFindTransfer): Promise<m10.sdk.transaction.IFinalizedTransfer[]> {
    if (req.txId != null) {
      return [await this.client.getTransfer(this.keyPair, { txId: req.txId })];
    } else if (req.contextId != null) {
      const txs = await this.client.listTransfers(this.keyPair, { contextId: req.contextId });
      return txs.transfers ?? [];
    } else {
      return [];
    }
  }

  async commitTransfer(pendingTxId: number | Long | null, contextId: Uint8Array | undefined): Promise<void> {
    const commitTransfer = new m10.sdk.transaction.CommitTransfer({
      pendingTxId,
      newState: m10.sdk.transaction.CommitTransfer.TransferState.ACCEPTED,
    });
    const transactionData = new m10.sdk.transaction.TransactionData({ commitTransfer });
    const transactionRequestPayload = this.client.transactionRequest(transactionData, contextId);
    const response = await this.client.createTransaction(this.keyPair, transactionRequestPayload);
    if (response.error != null) {
      this.log.fatal(`Could not commit transfer id=${pendingTxId}`);
    }
    return;
  }

  // TODO: Ensure restarts occur from a persisted starting point. Might be slow to catch up otherwise
  async observeTransfers(onTransfer: TransferCallback) {
    this.service?.end();

    const ownedAccounts = (await this.client.listAccounts(this.keyPair, { owner: this.keyPair.getPublicKey() })).accounts ?? [];
    for (const account of ownedAccounts) {
      this.log.info(`Owned account: ${account.name} => ${Buffer.from(account.id as Uint8Array).toString('hex')}`);
    }

    this.log.info(`Observing transfers`);
    const [service, start] = this.client.getObserveTransfers(this.keyPair, {
      involvedAccounts: ownedAccounts?.map(account => account.id as Uint8Array),
    });
    service.on('data', async finalized => {
      for await (const tx of finalized.transactions) {
        if (tx.response?.error != null) {
          return;
        }

        if (tx.request?.data?.initiateTransfer != null) {
          this.log.info(`Transfer initiated  ${tx.response?.txId}`);
          await onTransfer(tx.request?.contextId || new Uint8Array(0), tx.response.txId, tx.request.data?.initiateTransfer);
        }
      }
    });
    this.service = service;
    start();
  }

  close() {
    this.service?.end();
  }
}

export default M10Ledger;
