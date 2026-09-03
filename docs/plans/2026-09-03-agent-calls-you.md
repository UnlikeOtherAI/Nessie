# The assistant calls you

Phase 3 of [the voice-calling plan](2026-09-02-gemini-voice-calling.md), which
said each of these deserves its own spec. This is that spec: the assistant
places the call, and the person's own setting decides when it may.

Nothing here is built. It depends on phase 1b (CallKit) and 1c (Telecom),
because there is nothing to ring until the call provider exists.

## The setting

**"Make a call on important stuff while driving."** One scoped setting,
`voice.call.while_driving`, resolved through the
[scoped-settings](../../packages/runtime/src/scoped-settings.ts) chain —
organisation → team → person — so the person opts in for themselves and an
organisation that does not want agents ringing people at the wheel can lock it
off for everyone. Default off. It appears in personal settings alongside the
other scoped controls, through the existing `ScopedSettingGate`, which already
greys a control and names the level holding the lock.

The setting **widens what may ring, it never invents a reason to ring.** That
distinction is the whole design:

- Without it, the assistant may call you only for work you asked it to call
  you about — "ring me when the deploy finishes". Everything else is a message.
- With it on **and** the phone connected to a car, work the assistant judges
  important may ring instead of arriving as a message.
- With it on and the phone not in a car, nothing changes.

So the worst case the setting can produce is a call you would have received as
a message anyway, at a moment you had already told it you preferred a call.
The alternative reading — the car connection makes the assistant ring for
things it would otherwise never have raised — is deliberately not built: that
routes new interruptions to the moment a person is least able to handle them,
which is the thing Driving Focus exists to prevent.

**"Important" is a judgement, not a severity enum.** Nessie does not
string-match intent anywhere, and it must not start here: whether a result
warrants interrupting someone is exactly the kind of call a model makes and a
keyword list gets wrong. The agent decides; the setting bounds what that
decision is allowed to do.

## Detecting the car

What is actually detected is **connected to a car head unit**, which is not the
same as driving. It is true as a passenger, true parked with the engine
running, and false when driving an older car with the phone in a pocket. It is
a good proxy and the code should name it as one — `inCarSurface`, never
`isDriving`.

- **iOS:** `AVAudioSession.currentRoute.outputs` containing the `carAudio`
  port, with `routeChangeNotification` for the transitions. This is plain
  audio routing and needs no CarPlay entitlement. (The entitlement is only
  required to draw our own CarPlay UI, which we do not want: a CallKit call
  already appears on the CarPlay screen natively.)
- **Android:** `androidx.car.app.connection.CarConnection` reporting a
  projection connection. Any app may read it; it needs no Android Auto app
  approval.

## Where the decision is made, and why staleness is the hard part

The ring-or-message decision happens **on the server**, before it chooses a
push type — and on iOS, sending a VoIP push *obligates* a ring (below). So the
server needs to know about the car before it sends anything, and the device is
the only thing that knows.

The device can only report while it is running. If iOS kills the app while the
phone is connected, nothing tells the server the person got out of the car. So:

- **The car state is a heartbeat, not a latch.** The device re-asserts it while
  connected; when the heartbeat stops, it expires. This is the same shape as
  [`UserPushSurfacePresence`](../../api/src/services/push-surface-presence.ts),
  which the push decision already consults and which already expires after five
  minutes — the car surface belongs on that row rather than in a new subsystem.
- **The failure is asymmetric on purpose: stale or uncertain means message,
  never ring.** A missed ring is a message read two minutes later. A wrong ring
  is a phone going off in a meeting — and, given the obligation below, a push
  that had to become a call.

## iOS: the obligation that shapes everything

A ring is a VoIP push (PushKit) answered by CallKit's
`reportNewIncomingCall`. **iOS requires a call to be reported for every VoIP
push delivered.** Not most — every one. An app that takes a VoIP push without
ringing is terminated, and repeated offences cost the app VoIP delivery
entirely.

That inverts ordinary notification design, where a few extra sends are
harmless. Concretely:

- The worker must never send a speculative ring. Every VoIP push is a call the
  person will see.
- The decision — including the car heartbeat's freshness — is made **before**
  the push is sent, never in the handler.
- A VoIP push needs its own PushKit token (separate from the APNs token the
  device already registers), `apns-push-type: voip`, and the `<bundle>.voip`
  topic. Today [`packages/push/src/apns.ts`](../../packages/push/src/apns.ts)
  hardcodes `alert` and one topic, so both become parameters.

## Android

No PushKit. A high-priority FCM **data** message wakes the app, which calls
`ConnectionService.addNewIncomingCall` on the self-managed `PhoneAccount` from
phase 1c. There is no per-push ring obligation; the constraint is instead the
background-start and foreground-service policy, plus
`USE_FULL_SCREEN_INTENT` and `FOREGROUND_SERVICE_PHONE_CALL` — the latter
carrying a Play Console declaration. See
[the Android plan](2026-09-02-voice-android.md) §5.

## The tool

One PA builtin, `voice_call_start`, following the route-mirroring pattern the
existing `meeting_link_create` and `call_start` builtins established
([`packages/runtime/src/builtin-comms-tools.ts`](../../packages/runtime/src/builtin-comms-tools.ts),
dispatched in [`worker/src/run/tools.ts`](../../worker/src/run/tools.ts)). It
carries what the person asked to be called about, so "call me when the deploy
finishes" is one instruction rather than a standing subscription.

## What has to be true before this is done

- A person can turn it on and off in personal settings, and see when their
  organisation has locked it (Rule zero: the setting ships with the behaviour,
  never before it — a switch that controls nothing is a promise the product
  does not keep).
- Ringing works with the screen locked, on a real device, on cellular.
- The car heartbeat expires: verified by killing the app while connected and
  confirming the next notification is a message, not a call.
- No VoIP push is ever sent that does not ring.
