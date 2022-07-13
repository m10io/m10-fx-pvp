import { Logger } from 'tslog';
import M10Ledger from './ledger';
import { m10 } from 'm10-sdk/protobufs';
import { FxAgreement, FxQuote } from './protobuf/metadata';
import crypto, { createPublicKey } from 'crypto';

class PaymentManager {
  log: Logger;
  localLedger: M10Ledger;
  remoteLedger: M10Ledger;

  constructor(localLedger: M10Ledger, remoteLedger: M10Ledger) {
    this.log = new Logger({ name: 'Manager' });
    this.localLedger = localLedger;
    this.remoteLedger = remoteLedger;
  }

  async run() {
    this.localLedger.observeTransfers(this.checkAndExecuteSwap(this.remoteLedger));
    this.remoteLedger.observeTransfers(this.checkAndExecuteSwap(this.localLedger));

    // Keep foreground active
    await sleep(1 << 30);
  }

  checkAndExecuteSwap = (ledger: M10Ledger) => async (contextId: Uint8Array, txId: Long, transfer: m10.sdk.transaction.ICreateTransfer) => {
    const log = this.log.getChildLogger({ prefix: [`ledger=${this.localLedger.id}`, Buffer.from(contextId).toString('hex')] });
    log.info(`Checking swap`);
    // Validate FX quote
    const fxMeta = transfer.transferSteps?.flatMap(step => step.metadata).find(metadata => metadata?.type_url == FxAgreement.typeName);
    if (fxMeta == null) {
      this.log.info('No metadata found');
      return;
    }

    // Validate that the context ID is the hash of the FxAgreement
    const hash = crypto
      .createHash('sha256')
      .update(fxMeta.value as Uint8Array)
      .digest();
    if (!arrayEquals(hash, contextId)) {
      log.error('ContextID does not contain a valid FxAgreement hash');
      return;
    }

    // Validate FX quote signature
    let quote: FxQuote | null = null;
    try {
      const agreement = FxAgreement.fromBinary(fxMeta.value as Uint8Array);
      for (const signature of agreement.signatures) {
        const publicKey = createPublicKey({ key: publicKeyToDer(Buffer.from(signature.publicKey)), format: 'der', type: 'spki' });
        if (!crypto.verify(null, agreement.quote, publicKey, signature.signature)) {
          log.error('Invalid signature for FX quote');
          return;
        }
      }
      quote = FxQuote.fromBinary(agreement.quote);
    } catch (err) {
      log.error(`Could not validate FX quote: ${err}`);
      return;
    }

    // Validate we can process the qoute
    if (![this.localLedger.id, this.remoteLedger.id].includes(quote.base?.ledger ?? '')) {
      log.error(`Unsupported ledger ${quote.base?.ledger}`);
    }
    if (![this.localLedger.id, this.remoteLedger.id].includes(quote.target?.ledger ?? '')) {
      log.error(`Unsupported ledger ${quote.target?.ledger}`);
    }

    // Check if amount matches quoted amount
    const observedAmount = (quote.base?.ledger === ledger.id ? quote.target?.amount : quote.base?.amount) as bigint;
    log.info(`wantAmount=${observedAmount} found=${JSON.stringify(transfer.transferSteps?.map(s => s.amount))}`);
    if (
      transfer.transferSteps?.length === 0 ||
      transfer.transferSteps?.find(step => BigInt((step.amount as Long).toNumber()) === observedAmount) == null
    ) {
      log.error('Transfer did not match the quoted amount');
      return;
    }

    // Checking if the provided ledger also has a pending transfer
    log.info('Checking remote ledger..');
    const ledgerTransfers = await ledger.findTransfers({ contextId: contextId });
    if (ledgerTransfers.length === 0) {
      log.info('No remote transfer detected yet');
      return;
    }

    const checkedTransfer = ledgerTransfers
      .filter(checkedTransfer => {
        // Check if the other quote matches
        const checkedMeta = checkedTransfer.transferSteps?.flatMap(meta => meta.metadata).find(meta => meta?.type_url == FxAgreement.typeName);
        return checkedMeta != null && arrayEquals(checkedMeta.value as Uint8Array, fxMeta.value as Uint8Array);
      })
      .filter(checkedTransfer => checkedTransfer.error == null)
      .filter(checkedTransfer => {
        switch (checkedTransfer.state) {
          case m10.sdk.transaction.FinalizedTransfer.TransferState.PENDING:
          case m10.sdk.transaction.FinalizedTransfer.TransferState.ACCEPTED:
            return true;
          case m10.sdk.transaction.FinalizedTransfer.TransferState.EXPIRED:
          case m10.sdk.transaction.FinalizedTransfer.TransferState.REJECTED:
            log.warn(`Transaction ${checkedTransfer.txId} has already been canceled`);
            return false;
        }
      })
      .find(checkedTransfer => {
        // Validate the other quoted amount
        const checkedAmount = quote?.base?.ledger === ledger.id ? quote.base.amount : quote?.target?.amount;
        log.info(`wantAmount=${checkedAmount} found=${JSON.stringify(checkedTransfer.transferSteps?.map(s => s.amount))}`);
        return (
          checkedTransfer.transferSteps?.length != 0 &&
          checkedTransfer.transferSteps?.find(step => BigInt((step.amount as Long).toNumber()) === checkedAmount) != null
        );
      });

    if (checkedTransfer) {
      // Both pending transfers are present, commit the local one
      const txIdToCommit = this.localLedger.id === ledger.id ? (checkedTransfer.txId as number) : txId.toNumber();
      log.info(`Committing txId=${txIdToCommit}`);
      await this.localLedger.commitTransfer(txIdToCommit, checkedTransfer.contextId as Uint8Array);
    } else {
      log.info('Could not find matching quoted transfer');
    }
  };

  close() {
    this.log.info('Closing payments manager');
    this.localLedger.close();
    this.remoteLedger.close();
  }
}

const sleep = (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const arrayEquals = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((val, index) => val === b[index]);

const publicKeyToDer = (key: Buffer) => Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]);

export default PaymentManager;
