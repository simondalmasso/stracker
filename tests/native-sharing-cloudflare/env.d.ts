import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    NATIVE_SHARING: DurableObjectNamespace<NativeSharingDurableObject>
  }
}
