import {Command, Flags} from '@oclif/core'
import {readFileSync, writeFileSync} from 'node:fs'
import {CryptoSigner} from 'm10-sdk/out/utils'
import {LedgerClient} from 'm10-sdk/out/client'
import {Collection} from 'm10-sdk/out/collections'
import {m10} from 'm10-sdk/protobufs'
import {randomUUID, generateKeyPairSync} from 'node:crypto'
import * as uuid from 'uuid'

// m10_usd.pkcs8
const currencyPublicKey = '1oFEgUWFBVthmUNaaBDEmJB+0hE94+kQiI9Asadyfn4='
const roleName = 'conditional-payment-manager'

export default class Setup extends Command {
  static description = 'Setup the M10-FX identities'

  static examples = [
    'setup -s develop.m10.net -f ./m10_bm.pkcs8',
    'setup -s qa.m10.net -k MFMCAQEwBQYDK2VwBCIEIGnCNU8553Jq7aqK0zq+2YqED38MxGq4pA83mGCaDiIvoSMDIQA9E2FOITuigkjnsEK1+ggtsW8gsB1vgFNQi24Wfxr1dg==',
  ]

  static flags = {
    server: Flags.string({char: 's', description: 'M10 Ledger address', required: true}),
    keyPairPath: Flags.string({char: 'f', description: 'Path to a PKCS8 file'}),
    keyPair: Flags.string({char: 'k', description: 'Base64 encoded PKCS8'}),
  }

  static args = []

  public async run(): Promise<void> {
    const {flags} = await this.parse(Setup)

    const client = new LedgerClient(flags.server, true)

    let keyPair: CryptoSigner | null
    if (flags.keyPairPath) {
      const data = readFileSync(flags.keyPairPath, {encoding: 'base64'})
      keyPair = CryptoSigner.getSignerFromPkcs8V2(data)
      this.setup(client, keyPair)
    } else if (flags.keyPair) {
      keyPair = CryptoSigner.getSignerFromPkcs8V2(flags.keyPair)
      this.setup(client, keyPair)
    } else {
      this.log('expected either -p or -k arguments')
    }
  }

  async setup(client: LedgerClient, keyPair: CryptoSigner): Promise<void> {
    /// Find all bank accounts
    const bankAccounts = await (await client.listAccounts(keyPair, {owner: Buffer.from(currencyPublicKey, 'base64')})).accounts
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
    ]

    /// Check for existing roles
    const roles = await client.listRoles(keyPair, {name: roleName})
    if ((roles.roles?.length ?? 0) > 0) {
      this.log(`Role ${roleName} already exists:\n${JSON.stringify(roles.roles, null, 4)}`)
      return
    }

    /// Generate keypair
    const {privateKey} = generateKeyPairSync('ed25519')
    const exportedAccountKeyPair = privateKey.export({type: 'pkcs8', format: 'pem'})
    const accountKeyPair = new CryptoSigner(exportedAccountKeyPair)

    /// Create role for the rules
    const roleId = randomUUID()
    const role = new m10.sdk.Role({
      id: Uint8Array.from(uuid.parse(roleId)),
      name: roleName,
      owner: accountKeyPair.getPublicKey(),
      rules: rules,
    })

    // Create role-binding for the keypair
    const roleBinding = new m10.sdk.RoleBinding({
      id: Uint8Array.from(uuid.parse(roleId)),
      isUniversal: false,
      name: roleName,
      role: Uint8Array.from(uuid.parse(roleId)),
      owner: accountKeyPair.getPublicKey(),
      subjects: [accountKeyPair.getPublicKey()],
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
    const response = await client.createTransaction(keyPair, transactionRequestPayload)
    if (response.error) {
      this.log(`Could not create role / role-binding ${roleId}: ${JSON.stringify(response.error, null, 4)}`)
    }

    const keyPairFile = './key_pair.pkcs8'
    writeFileSync('./key_pair.pkcs8', exportedAccountKeyPair)
    this.log(`>>> Wrote keypair to (${keyPairFile}):\n${accountKeyPair.getPublicKey().toString('base64')}`)
  }
}