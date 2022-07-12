import {CryptoSigner} from 'm10-sdk/out/utils'
import {readFileSync} from 'node:fs'

export function keyPairFromFlags(keyPairPath?: string, keyPair?: string): CryptoSigner | null {
  if (keyPairPath) {
    const data = readFileSync(keyPairPath, {encoding: 'base64'})
    return CryptoSigner.getSignerFromPkcs8V2(data)
  }

  if (keyPair) {
    return CryptoSigner.getSignerFromPkcs8V2(keyPair)
  }

  return null
}
