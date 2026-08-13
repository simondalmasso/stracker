type StrackerOwnedBufferSource = ArrayBuffer | Uint8Array<ArrayBufferLike>

interface StrackerAesGcmParams extends Algorithm {
  iv: StrackerOwnedBufferSource
  additionalData?: StrackerOwnedBufferSource
  tagLength?: number
}

interface SubtleCrypto {
  digest(algorithm: AlgorithmIdentifier, data: StrackerOwnedBufferSource): Promise<ArrayBuffer>
  encrypt(algorithm: AlgorithmIdentifier | StrackerAesGcmParams, key: CryptoKey, data: StrackerOwnedBufferSource): Promise<ArrayBuffer>
  decrypt(algorithm: AlgorithmIdentifier | StrackerAesGcmParams, key: CryptoKey, data: StrackerOwnedBufferSource): Promise<ArrayBuffer>
}
