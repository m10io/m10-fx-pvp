import {Command, Flags} from '@oclif/core'
import {CryptoSigner} from 'm10-sdk/out/utils'
import {LedgerClient} from 'm10-sdk/out/client'
import {Collection} from 'm10-sdk/out/collections'
import {m10} from 'm10-sdk/protobufs'
import {randomUUID} from 'node:crypto'
import * as uuid from 'uuid'
import {keyPairFromFlags} from '../utils'
import {createAccount} from 'm10-sdk/out/helpers/accounts'
import {getAccountIdFromUint8Array} from 'm10-sdk/out/utils/account_id'
import {collections} from 'm10-sdk'

// m10_usd.pkcs8
const currencyPublicKey = '1oFEgUWFBVthmUNaaBDEmJB+0hE94+kQiI9Asadyfn4='
const roleName = 'conditional-payment-manager'

export default class Setup extends Command {
  static description = 'Setup the M10-FX identities'

  static examples = [
    'setup -s develop.m10.net -f ./m10_root.pkcs8',
    'setup -s qa.m10.net -k MFMCAQEwBQYDK2VwBCIEIGnCNU8553Jq7aqK0zq+2YqED38MxGq4pA83mGCaDiIvoSMDIQA9E2FOITuigkjnsEK1+ggtsW8gsB1vgFNQi24Wfxr1dg==',
  ]

  static flags = {
    server: Flags.string({char: 's', description: 'M10 Ledger address', required: true}),
    rootKeyPairPath: Flags.string({char: 'f', description: 'Path to a PKCS8 file. Needs RBAC permissions to create roles/role-bindings/accounts/transfers', exclusive: ['rootKeyPair']}),
    rootKeyPair: Flags.string({char: 'k', description: 'Base64 encoded PKCS8. Needs RBAC permissions to create roles/role-bindings/accounts/transfers', exclusive: ['rootKeyPairPath']}),
    pvpKeyPairPath: Flags.string({char: 'F', description: 'Path to a PKCS8 file', exclusive: ['pvpKeyPair']}),
    pvpKeyPair: Flags.string({char: 'K', description: 'Base64 encoded PKCS8.', exclusive: ['pvpKeyPairPath']}),
  }

  static args = []

  public async run(): Promise<void> {
    const {flags} = await this.parse(Setup)

    const client = new LedgerClient(flags.server, true)

    const rootKeyPair = keyPairFromFlags(flags.rootKeyPairPath, flags.rootKeyPair)
    const pvpKeyPair = keyPairFromFlags(flags.pvpKeyPairPath, flags.pvpKeyPair)
    if (rootKeyPair && pvpKeyPair) {
      this.setup(client, rootKeyPair, pvpKeyPair)
    } else {
      this.log('expected either -p or -k arguments')
    }
  }

  async setup(client: LedgerClient, rootKeyPair: CryptoSigner, pvpKeyPair: CryptoSigner): Promise<void> {
    /// Find all bank accounts
    const bankAccounts = await (await client.listAccounts(rootKeyPair, {owner: Buffer.from(currencyPublicKey, 'base64')})).accounts
    this.log(`Known bank accounts: ${JSON.stringify(bankAccounts, null, 4)}`)

    /// RBAC rules
    const rules: m10.sdk.Rule[] = [
      /// Allows reading & committing transfers on transfers between bank accounts
      /// Note: @sadroeck - Can be limited to CB & List of appropriate banks
      new m10.sdk.Rule({
        collection: 'ledger-accounts',
        verbs: [m10.sdk.Rule.Verb.READ, m10.sdk.Rule.Verb.COMMIT],
        instanceKeys: bankAccounts?.map(account =>
          new m10.sdk.Value({bytesValue: account.id})),
      }),
      new m10.sdk.Rule({
        collection: collections.Collection.Account,
        verbs: [m10.sdk.Rule.Verb.READ, m10.sdk.Rule.Verb.COMMIT],
        instanceKeys: bankAccounts?.map(account =>
          new m10.sdk.Value({bytesValue: account.id})),
      }),
    ]

    /// Check for existing roles
    const roles = await client.listRoles(rootKeyPair, {name: roleName})
    if ((roles.roles?.length ?? 0) > 0) {
      this.error(`Role ${roleName} already exists:\n${JSON.stringify(roles.roles, null, 4)}`)
    }

    /// Create role for the rules
    const roleId = randomUUID()
    const role = new m10.sdk.Role({
      id: Uint8Array.from(uuid.parse(roleId)),
      name: roleName,
      owner: pvpKeyPair.getPublicKey(),
      rules: rules,
    })

    // Create role-binding for the keypair
    const roleBinding = new m10.sdk.RoleBinding({
      id: Uint8Array.from(uuid.parse(roleId)),
      isUniversal: false,
      name: roleName,
      role: Uint8Array.from(uuid.parse(roleId)),
      owner: pvpKeyPair.getPublicKey(),
      subjects: [pvpKeyPair.getPublicKey()],
    })

    /// Submit role & role-binding
    const documentOperations = new m10.sdk.DocumentOperations({operations: [
      new m10.sdk.Operation({
        insertDocument: new m10.sdk.Operation.InsertDocument({
          collection: Collection.Role,
          document: m10.sdk.Role.encode(role).finish(),
        }),
      }),
      new m10.sdk.Operation({
        insertDocument: new m10.sdk.Operation.InsertDocument({
          collection: Collection.RoleBinding,
          document: m10.sdk.RoleBinding.encode(roleBinding).finish(),
        }),
      }),
    ]})
    const transactionData = new m10.sdk.transaction.TransactionData({documentOperations})
    const transactionRequestPayload = client.transactionRequest(transactionData)
    const response = await client.createTransaction(rootKeyPair, transactionRequestPayload)
    if (response.error) {
      this.error(`Could not create role / role-binding ${roleId}: ${JSON.stringify(response.error, null, 4)}`)
    }

    this.log(`Registered pvpManager role with owner ${pvpKeyPair.getPublicKey().toString('base64')}`)

    // Create accounts
    for await (const account of bankAccounts ?? []) {
      // Create account
      const indexedAccount = await client.getIndexedAccount(rootKeyPair, {id: account.id})
      const createLedgerAccount = new m10.sdk.transaction.CreateLedgerAccount({frozen: false, issuance: false, parentId: indexedAccount.id})
      let transactionData = new m10.sdk.transaction.TransactionData({createLedgerAccount})
      let transactionRequestPayload = client.transactionRequest(transactionData)
      let response = await client.createTransaction(rootKeyPair, transactionRequestPayload)
      if (response.error) {
        this.error(`Could not create ledger account for currency ${indexedAccount.instrument?.code}: ${JSON.stringify(response.error, null, 4)}`)
      } else {
        this.log(`Created ${indexedAccount.instrument?.code} account: ${getAccountIdFromUint8Array(response.accountCreated as Uint8Array)}`)
      }

      const accountId = response.accountCreated as Uint8Array
      this.log(`Registering account document: ${getAccountIdFromUint8Array(accountId)}`)
      // Register account doc
      await createAccount(client, rootKeyPair, getAccountIdFromUint8Array(accountId), `M10 PVP ${indexedAccount.instrument?.code}`)

      // Fund account
      const amount = 100_000
      const fundAccount = new m10.sdk.transaction.CreateTransfer({transferSteps: [new m10.sdk.transaction.TransferStep({fromAccountId: indexedAccount.id, toAccountId: accountId, amount: amount, metadata: []})]})
      transactionData = new m10.sdk.transaction.TransactionData({transfer: fundAccount})
      transactionRequestPayload = client.transactionRequest(transactionData)
      response = await client.createTransaction(rootKeyPair, transactionRequestPayload)
      if (response.error) {
        this.error(`Could not fund ledger account: ${JSON.stringify(response.error, null, 4)}`)
      } else {
        this.log(`Funded account ${amount}`)
      }
    }
  }
}
