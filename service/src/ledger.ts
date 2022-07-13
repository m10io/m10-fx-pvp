import { LedgerClient } from 'm10-sdk/out/client';
import { CryptoSigner, getUint8ArrayFromAccountId } from 'm10-sdk/out/utils';
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
  private accountId: string;
  private keyPair: CryptoSigner;
  private service?: m10.sdk.M10QueryService;
  private operator: string;
  id: string;

  constructor(operator: string, url: string, accountId: string, keyPair: string) {
    this.log = new Logger();
    this.client = new LedgerClient(url, true);
    this.accountId = accountId;
    // NOTE @sadroeck - Prefer to sign via an external vault (e.g. Vault/aws-KMS/..). Fine for demo
    this.keyPair = CryptoSigner.getSignerFromPkcs8V2(keyPair);
    this.operator = operator;
    this.id = `unknown.${operator}`;

    this.log.info(
      `Connecting to M10 ledger operator=${this.operator} accountId=${this.accountId} publicKey=${this.keyPair.getPublicKey().toString('base64')}`,
    );
  }

  publicKey(): Buffer {
    return this.keyPair.getPublicKey();
  }

  async findTransfers(req: IFindTransfer): Promise<m10.sdk.transaction.IFinalizedTransfer[]> {
    if (req.txId != null) {
      return [await this.client.getTransfer(this.keyPair, req)];
    } else if (req.contextId != null) {
      const txs = await this.client.listTransfers(this.keyPair, { limit: 10, ...req });
      return txs.transfers ?? [];
    } else {
      throw 'missing filter for findTransfers';
    }
  }

  async commitTransfer(pendingTxId: number, contextId: Uint8Array): Promise<void> {
    const commitTransfer = new m10.sdk.transaction.CommitTransfer({
      pendingTxId,
      newState: m10.sdk.transaction.CommitTransfer.TransferState.ACCEPTED,
    });
    const transactionData = new m10.sdk.transaction.TransactionData({ commitTransfer });
    const transactionRequestPayload = this.client.transactionRequest(transactionData, contextId);
    const response = await this.client.createTransaction(this.keyPair, transactionRequestPayload);
    if (response.error != null) {
      this.log.fatal(`Could not commit transfer id=${pendingTxId}: ${JSON.stringify(response.error)}`);
    }
    return;
  }

  // TODO: Ensure restarts occur from a persisted starting point. Might be slow to catch up otherwise
  async observeTransfers(onTransfer: TransferCallback) {
    this.service?.end();

    this.log.info(`Trying to find account ${this.accountId}`);
    const account = await this.client.getIndexedAccount(this.keyPair, { id: getUint8ArrayFromAccountId(this.accountId) });
    this.id = `${account.instrument?.code?.toLowerCase()}.${this.operator}`;
    this.log = new Logger({ name: `ledger=${this.id}` });
    this.log.info(`Owned account: ${account.instrument?.code} => ${Buffer.from(account.id as Uint8Array).toString('hex')}`);

    this.log.info(`Observing transfers`);
    const [service, start] = this.client.getObserveTransfers(this.keyPair, {
      involvedAccounts: [account.id as Uint8Array],
    });
    service.on('data', async (finalized: m10.sdk.IFinalizedTransactions) => {
      for await (const tx of finalized.transactions ?? []) {
        if (tx.response?.error != null) {
          this.log.error(`Observed error: ${JSON.stringify(tx.response.error)}`);
          return;
        }

        if (tx.request?.data?.initiateTransfer != null) {
          this.log.info(`Transfer initiated  ${tx.response?.txId}`);
          await onTransfer(tx.request?.contextId || new Uint8Array(0), tx.response?.txId as Long, tx.request.data?.initiateTransfer);
        } else if (tx.response?.transferCommitted != null) {
          this.log.info(`Transfer committed ${tx.response?.txId}`);
          // await onTransfer(
          //   tx.request?.contextId || new Uint8Array(0),
          //   tx.request?.data?.commitTransfer?.pendingTxId as Long,
          //   tx.response.transferCommitted,
          // );
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
