import { Logger } from 'tslog';
import M10Ledger from './ledger';
import { m10 } from 'm10-sdk/protobufs';
import { FxAgreement, FxQuote } from './protobuf/metadata';
import crypto from 'crypto';

class PaymentManager {
  log: Logger;
  localLedger: M10Ledger;
  remoteLedger: M10Ledger;

  constructor(log: Logger, localLedger: M10Ledger, remoteLedger: M10Ledger) {
    this.log = log;
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
    // Validate FX quote
    const fxMeta = transfer.transferSteps?.flatMap(step => step.metadata).find(metadata => metadata?.type_url == FxQuote.typeName);
    if (fxMeta == null) {
      return;
    }

    // Validate that the context ID is the hash of the FxAgreement
    const hash = crypto
      .createHash('sha256')
      .update(fxMeta.value as Uint8Array)
      .digest();
    if (!arrayEquals(hash, contextId)) {
      this.log.error('ContextID does not contain a valid FxAgreement hash');
      return;
    }

    // Validate FX quote signature
    let quote: FxQuote | null = null;
    try {
      const agreement = FxAgreement.fromBinary(fxMeta.value as Uint8Array);
      for (const signature of agreement.signatures) {
        if (!crypto.verify(signature.algorithm.toString().toLowerCase(), agreement.quote, Buffer.from(signature.publicKey), signature.signature)) {
          this.log.error('Invalid signature for FX quote');
          return;
        }
      }
      quote = FxQuote.fromBinary(agreement.quote);
    } catch (err) {
      this.log.error(`Could not decode FX quote: ${err}`);
      return;
    }

    // Check if amount matches quoted amount
    const observedAmount = quote.base?.ledger === ledger.id ? quote.target?.amount : quote.base?.amount;
    if (transfer.transferSteps == [] || transfer.transferSteps?.find(step => step.amount === observedAmount) == null) {
      this.log.error('Could not match the quoted amount');
      return;
    }

    // Checking if the provided ledger also has a pending transfer
    this.log.info('Checking remote ledger');
    const ledgerTransfers = await ledger.findTransfers({ contextId: contextId });
    for (const checkedTransfer of ledgerTransfers) {
      // Check if the other quote matches
      const checkedMeta = checkedTransfer.transferSteps?.flatMap(meta => meta.metadata).find(meta => meta?.type_url == FxAgreement.typeName);
      if (checkedMeta == null || !arrayEquals(checkedMeta.value as Uint8Array, fxMeta.value as Uint8Array)) {
        continue;
      }
      switch (checkedTransfer.state) {
        case m10.sdk.transaction.FinalizedTransfer.TransferState.PENDING:
          // Validate the other quoted amount
          const checkedAmount = quote.base?.ledger === ledger.id ? quote.base.amount : quote.target?.amount;
          if (checkedTransfer.transferSteps == [] || checkedTransfer.transferSteps?.find(step => step.amount === checkedAmount) == null) {
            this.log.error('Could not match the quoted amount');
            return;
          }
          // Both pending transfers are present, commit the local one
          await this.localLedger.commitTransfer(
            this.localLedger === ledger ? (checkedTransfer.txId as Long) : txId,
            checkedTransfer.contextId ?? undefined,
          );
          break;
        case m10.sdk.transaction.FinalizedTransfer.TransferState.EXPIRED:
        case m10.sdk.transaction.FinalizedTransfer.TransferState.REJECTED:
          this.log.warn(`Transaction ${checkedTransfer.txId} has already been canceled`);
          break;
        case m10.sdk.transaction.FinalizedTransfer.TransferState.ACCEPTED:
          this.log.info(`Transation ${checkedTransfer.txId} has already been accepted`);
          break;
      }
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
export default PaymentManager;
