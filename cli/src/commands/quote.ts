import {Command, Flags} from '@oclif/core'
import {LedgerClient} from 'm10-sdk/out/client'
import {FxAgreement, FxAmount, FxQuote} from '../protobuf/metadata'
import {m10, google} from 'm10-sdk/protobufs'
import {keyPairFromFlags} from '../utils'
import crypto from 'node:crypto'
import yesno from 'yesno'

// M10 EUR
const quotePublisherAccountId = '04000000000000000000000000000000'

export default class Quote extends Command {
  static description = 'Publishes an FxAgreement for baseAmount of B currency -> targetAmount of T currency'

  static examples = [
    'quote -B  -b 100 -T  -t 90 -l develop.m10.net -f ./m10_usd.pkcs8',
  ]

  static flags = {
    from: Flags.string({char: 'B', description: 'Sender of the base amount', required: true}),
    to: Flags.string({char: 'T', description: 'Receiver of the target amount', required: true}),
    baseAmount: Flags.integer({char: 'b', description: 'base amount', required: true}),
    targetAmount: Flags.integer({char: 't', description: 'target amount', required: true}),
    ledger: Flags.string({char: 's', description: 'ledger address', required: true}),
    keyPairPath: Flags.string({char: 'f', description: 'Path to a PKCS8 file', exclusive: ['keyPair']}),
    keyPair: Flags.string({char: 'k', description: 'Base64 encoded PKCS8', exclusive: ['keyPairPath']}),
  }

  static args = []

  public async run(): Promise<void> {
    const {flags} = await this.parse(Quote)

    const keyPair = keyPairFromFlags(flags.keyPairPath, flags.keyPair)
    if (!keyPair) {
      this.log('expected either -p or -k arguments')
      return
    }

    // Check sender & receiver
    const client = new LedgerClient(flags.ledger, true)
    const fromAccount = await client.getIndexedAccount(keyPair, {id: Buffer.from(flags.from, 'hex')})
    const toAccount = await client.getIndexedAccount(keyPair, {id: Buffer.from(flags.to, 'hex')})

    // Find Central Bank accounts
    let baseCBAccount
    let targetCBAccount
    const bankAccounts = await (await client.listAccounts(keyPair, {owner: keyPair.getPublicKey()})).accounts
    for await (const account of bankAccounts ?? []) {
      if (baseCBAccount !== null && targetCBAccount !== null) {
        break
      }

      const ledgerAccount = await client.getIndexedAccount(keyPair, {id: account.id})
      if (ledgerAccount.instrument === fromAccount.instrument) {
        baseCBAccount = ledgerAccount
      }

      if (ledgerAccount.instrument === toAccount.instrument) {
        targetCBAccount = ledgerAccount
      }
    }

    if (baseCBAccount === null) {
      this.error(`Currency ${fromAccount.instrument} is not supported`)
    }

    if (targetCBAccount === null) {
      this.error(`Currency ${toAccount.instrument} is not supported`)
    }

    // Create FX agreement
    const fromCurrency = fromAccount.instrument?.code?.toLowerCase()
    const base = FxAmount.create({amount: BigInt(flags.baseAmount), currency: fromCurrency, ledger: `${fromCurrency}.m10`})
    const toCurrency = toAccount.instrument?.code?.toLowerCase()
    const target = FxAmount.create({amount: BigInt(flags.targetAmount), currency: toCurrency, ledger: `${toCurrency}.m10`})
    const quote = FxQuote.create({base, target})
    const serializedQuote = FxQuote.toBinary(quote)
    const agreement = FxAgreement.create({quote: serializedQuote, signatures: [keyPair.getSignature(serializedQuote)]})
    const serializedAgreement = FxAgreement.toBinary(agreement)
    const contextId = crypto
    .createHash('sha256')
    .update(serializedAgreement as Uint8Array)
    .digest()

    // Publish to ledger
    const publishAgreement = new m10.sdk.transaction.Action({
      name: 'm10.fx-agreement',
      fromAccount: Buffer.from(quotePublisherAccountId, 'hex'),
      // Note: Target::AnyAccount is not yet published to the SDK, so use relevant observing account
      target: {accountId: Buffer.from('00000000000000000000000000000000', 'hex')},
      payload: serializedAgreement,
    })
    const transactionData = new m10.sdk.transaction.TransactionData({invokeAction: publishAgreement})
    const transactionRequestPayload = client.transactionRequest(transactionData, contextId)
    const response = await client.createTransaction(keyPair, transactionRequestPayload)
    if (response.error !== null) {
      this.error(`Could not publish quote: ${JSON.stringify(response.error)}`)
      return
    }

    this.log(`Published quote as txId=${response.txId}`)

    const executeBase = await yesno({
      question: `Would you like to execute the ${fromCurrency} section?`,
      defaultValue: true,
    })

    if (executeBase) {
      const initiateTransfer = new m10.sdk.transaction.CreateTransfer({
        transferSteps: [
          new m10.sdk.transaction.TransferStep({
            fromAccountId: fromAccount?.id,
            toAccountId: baseCBAccount?.id,
            amount: flags.baseAmount,
            metadata: [new google.protobuf.Any({
              // eslint-disable-next-line camelcase
              type_url: FxAgreement.typeName,
              value: serializedAgreement})]}),
        ],
      })
      const transactionData = new m10.sdk.transaction.TransactionData({initiateTransfer})
      const transactionRequestPayload = client.transactionRequest(transactionData, contextId)
      const response = await client.createTransaction(keyPair, transactionRequestPayload)
      if (response.error !== null) {
        this.error(`Could not initiate transfer: ${JSON.stringify(response.error)}`)
      }
    }

    const executeTarget = await yesno({
      question: `Would you like to execute the ${toCurrency} section?`,
      defaultValue: true,
    })

    if (executeTarget) {
      const initiateTransfer = new m10.sdk.transaction.CreateTransfer({
        transferSteps: [
          new m10.sdk.transaction.TransferStep({
            fromAccountId: targetCBAccount?.id,
            toAccountId: toAccount?.id,
            amount: flags.baseAmount,
            metadata: [new google.protobuf.Any({
              // eslint-disable-next-line camelcase
              type_url: FxAgreement.typeName,
              value: serializedAgreement})]}),
        ],
      })
      const transactionData = new m10.sdk.transaction.TransactionData({initiateTransfer})
      const transactionRequestPayload = client.transactionRequest(transactionData, contextId)
      const response = await client.createTransaction(keyPair, transactionRequestPayload)
      if (response.error !== null) {
        this.error(`Could not initiate transfer: ${JSON.stringify(response.error)}`)
      }
    }
  }
}
