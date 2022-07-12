import {Command, Flags} from '@oclif/core'
import {LedgerClient} from 'm10-sdk/out/client'
import {FxAgreement, FxAmount, FxQuote} from '../protobuf/metadata'
import {m10} from 'm10-sdk/protobufs'
import {keyPairFromFlags} from '../utils'
import crypto from 'node:crypto'

// M10 EUR
const quotePublisherAccountId = '04000000000000000000000000000000'

export default class Quote extends Command {
  static description = 'Publishes an FxAgreement for B of currency b -> T of currency t'

  static examples = [
    'quote -b usd -B 100 -t eur -T 95 -l develop.m10.net -f ./m10_usd.pkcs8',
  ]

  static flags = {
    baseCurrency: Flags.string({char: 'b', description: 'base currency name', required: true}),
    targetCurrency: Flags.string({char: 't', description: 'target currency name', required: true}),
    baseAmount: Flags.integer({char: 'B', description: 'base amount', required: true}),
    targetAmount: Flags.integer({char: 'T', description: 'target amount', required: true}),
    ledger: Flags.string({char: 's', description: 'ledger address', required: true}),
    keyPairPath: Flags.string({char: 'f', description: 'Path to a PKCS8 file'}),
    keyPair: Flags.string({char: 'k', description: 'Base64 encoded PKCS8'}),
  }

  static args = []

  public async run(): Promise<void> {
    const {flags} = await this.parse(Quote)

    const keyPair = keyPairFromFlags(flags.keyPairPath, flags.keyPair)
    if (!keyPair) {
      this.log('expected either -p or -k arguments')
      return
    }

    // Create FX agreement
    const base = FxAmount.create({amount: BigInt(flags.baseAmount), currency: flags.baseCurrency.toLowerCase(), ledger: `${flags.baseCurrency.toLowerCase()}.m10`})
    const target = FxAmount.create({amount: BigInt(flags.targetAmount), currency: flags.targetCurrency.toLowerCase(), ledger: `${flags.targetCurrency.toLowerCase()}.m10`})
    const quote = FxQuote.create({base, target})
    const serializedQuote = FxQuote.toBinary(quote)
    const agreement = FxAgreement.create({quote: serializedQuote, signatures: [keyPair.getSignature(serializedQuote)]})
    const serializedAgreement = FxAgreement.toBinary(agreement)
    const contextId = crypto
    .createHash('sha256')
    .update(serializedAgreement as Uint8Array)
    .digest()

    // Publish to ledger
    const client = new LedgerClient(flags.ledger, true)
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
      this.log(`Could not commit transfer id: ${JSON.stringify(response.error)}`)
      return
    }

    this.log(`Published quote as txId=${response.txId}`)
  }
}
