/**
 * Optional convenience wrapper that caches an {@link ApnsClient} /
 * {@link FcmClient} across calls so the APNs JWT + HTTP/2 session and the FCM
 * access token survive between sends.
 *
 * This binds to a single set of APNs and/or FCM credentials. A caller that
 * delivers many notifications for one app should construct it once and call
 * {@link PushSender.sendApns} / {@link PushSender.sendFcm} repeatedly, then
 * {@link PushSender.close} when done.
 */
import { ApnsClient } from './apns.js'
import { FcmClient } from './fcm.js'
import type { ApnsTransportFactory, FetchLike } from './transport.js'
import type {
  ApnsCredentials,
  FcmCredentials,
  PushPayload,
  PushResult,
  PushTarget,
} from './types.js'

export interface PushSenderOptions {
  apns?: ApnsCredentials
  fcm?: FcmCredentials
  /** Override the APNs HTTP/2 transport (mainly for tests). */
  apnsTransportFactory?: ApnsTransportFactory
  /** Override the FCM fetch implementation (mainly for tests). */
  fetchImpl?: FetchLike
  /** Override the clock (mainly for tests). */
  now?: () => number
}

export class PushSender {
  private readonly apnsClient?: ApnsClient
  private readonly fcmClient?: FcmClient

  constructor(options: PushSenderOptions) {
    if (options.apns) {
      this.apnsClient = new ApnsClient(
        options.apns,
        options.apnsTransportFactory,
        options.now,
      )
    }
    if (options.fcm) {
      this.fcmClient = new FcmClient(options.fcm, options.fetchImpl, options.now)
    }
  }

  sendApns(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    if (!this.apnsClient) {
      throw new Error('PushSender was constructed without APNs credentials')
    }
    return this.apnsClient.send(target, payload)
  }

  sendFcm(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    if (!this.fcmClient) {
      throw new Error('PushSender was constructed without FCM credentials')
    }
    return this.fcmClient.send(target, payload)
  }

  /** Tear down the APNs HTTP/2 session (FCM holds no session). */
  async close(): Promise<void> {
    if (this.apnsClient) await this.apnsClient.close()
  }
}
