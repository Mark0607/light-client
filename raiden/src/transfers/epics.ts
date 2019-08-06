/* eslint-disable @typescript-eslint/camelcase */
import { of, from, combineLatest, merge, Observable, EMPTY } from 'rxjs';
import {
  catchError,
  concatMap,
  filter,
  first,
  map,
  mergeMap,
  withLatestFrom,
  take,
  ignoreElements,
  repeatWhen,
  delay,
  takeUntil,
  exhaustMap,
  publishReplay,
} from 'rxjs/operators';
import { ActionType, isActionOf } from 'typesafe-actions';
import { bigNumberify, keccak256 } from 'ethers/utils';
import { Zero } from 'ethers/constants';
import { findKey, get } from 'lodash';

import { RaidenEpicDeps } from '../types';
import { RaidenAction } from '../actions';
import { RaidenState } from '../store';
import { REVEAL_TIMEOUT } from '../constants';
import { Address, Hash, UInt } from '../utils/types';
import { splitCombined } from '../utils/rxjs';
import { raidenInit } from '../store/actions';
import { Presences } from '../transport/types';
import { getPresences$ } from '../transport/utils';
import { messageReceived, messageSend, messageSent } from '../messages/actions';
import {
  MessageType,
  LockedTransfer,
  Processed,
  SecretRequest,
  SecretReveal,
  Unlock,
  Signed,
  LockExpired,
} from '../messages/types';
import { signMessage, getBalanceProofFromEnvelopeMessage } from '../messages/utils';
import { ChannelState, Channel } from '../channels/state';
import { Lock } from '../channels/types';
import { newBlock, channelClosed, channelClose } from '../channels/actions';
import {
  transfer,
  transferSigned,
  transferSecret,
  transferProcessed,
  transferFailed,
  transferSecretRequest,
  transferUnlock,
  transferUnlocked,
  transferred,
  transferExpire,
  transferExpired,
  transferExpireFailed,
  transferSecretReveal,
  transferClear,
} from './actions';
import { getLocksroot, makePaymentId, makeMessageId } from './utils';

/**
 * Create an observable to compose and sign a LockedTransfer message/transferSigned action
 * As it's an async observable which depends on state and may return an action which changes it,
 * the returned observable must be subscribed in a serialized context that ensures non-concurrent
 * write access to the channel's balance proof (e.g. concatMap)
 *
 * @param presences$  Observable of address to last matrixPresenceUpdate mapping
 * @param state$  Observable of current state
 * @param action  transfer request action to be sent
 * @param network,address,signer  RaidenEpicDeps members
 * @returns  Observable of transferSigned|transferSecret|transferFailed actions
 */
function makeAndSignTransfer(
  presences$: Observable<Presences>,
  state$: Observable<RaidenState>,
  action: ActionType<typeof transfer>,
  { network, address, signer }: RaidenEpicDeps,
) {
  return combineLatest(presences$, state$).pipe(
    first(),
    mergeMap(([presences, state]) => {
      if (action.meta.secrethash in state.sent) {
        // don't throw to avoid emitting transferFailed, to just wait for already pending transfer
        console.error('transfer already present', action.meta);
        return EMPTY;
      }

      if (!(action.payload.target in presences)) throw new Error('target not monitored');
      if (!presences[action.payload.target].payload.available)
        throw new Error('target not available/online');

      let secret = action.payload.secret;
      if (secret && keccak256(secret) !== action.meta.secrethash) {
        throw new Error('secrethash does not match provided secret');
      }

      let recipient: Address | undefined = undefined;
      // find a route
      for (const [key, channel] of Object.entries(state.channels[action.payload.tokenNetwork])) {
        const partner = key as Address;
        // capacity is own deposit - (own trasferred + locked) + (partner transferred)
        const capacity = channel.own.deposit
          .sub(
            channel.own.balanceProof
              ? channel.own.balanceProof.transferredAmount.add(
                  channel.own.balanceProof.lockedAmount,
                )
              : Zero,
          )
          .add(
            // only relevant once we can receive from partner
            channel.partner.balanceProof ? channel.partner.balanceProof.transferredAmount : Zero,
          );
        if (channel.state !== ChannelState.open) {
          console.warn(
            `transfer: channel with "${partner}" in state "${channel.state}" instead of "${ChannelState.open}"`,
          );
        } else if (capacity.lt(action.payload.amount)) {
          console.warn(
            `transfer: channel with "${partner}" without enough capacity (${capacity.toString()})`,
          );
        } else if (!(partner in presences) || !presences[partner].payload.available) {
          console.warn(`transfer: partner "${partner}" not available in transport`);
        } else {
          recipient = partner;
          break;
        }
      }
      if (!recipient)
        throw new Error('Could not find an online partner for tokenNetwork with enough capacity');

      const channel = state.channels[action.payload.tokenNetwork][recipient];
      // check below never fail, because of for loop filter, just for type narrowing
      if (channel.state !== ChannelState.open) throw new Error('not open');

      let paymentId = action.payload.paymentId;
      if (!paymentId) paymentId = makePaymentId();

      const lock: Lock = {
          type: 'Lock',
          amount: action.payload.amount,
          expiration: bigNumberify(state.blockNumber + REVEAL_TIMEOUT * 2) as UInt<32>,
          secrethash: action.meta.secrethash,
        },
        locks: Lock[] = [...(channel.own.locks || []), lock],
        locksroot = getLocksroot(locks),
        fee = action.payload.fee || (Zero as UInt<32>),
        msgId = makeMessageId(),
        token = findKey(state.tokens, tn => tn === action.payload.tokenNetwork)! as Address;

      const message: LockedTransfer = {
        type: MessageType.LOCKED_TRANSFER,
        message_identifier: msgId,
        chain_id: bigNumberify(network.chainId) as UInt<32>,
        token_network_address: action.payload.tokenNetwork,
        channel_identifier: bigNumberify(channel.id) as UInt<32>,
        nonce: (channel.own.balanceProof ? channel.own.balanceProof.nonce : Zero).add(1) as UInt<
          8
        >,
        transferred_amount: (channel.own.balanceProof
          ? channel.own.balanceProof.transferredAmount
          : Zero) as UInt<32>,
        locked_amount: (channel.own.balanceProof
          ? channel.own.balanceProof.lockedAmount
          : Zero
        ).add(action.payload.amount) as UInt<32>,
        locksroot,
        payment_identifier: paymentId,
        token,
        recipient,
        lock,
        target: action.payload.target,
        initiator: address,
        fee,
      };
      return from(signMessage(signer, message)).pipe(
        mergeMap(function*(signed) {
          // besides transferSigned, also yield transferSecret (for registering) if we know it
          if (secret) yield transferSecret({ secret }, { secrethash: action.meta.secrethash });
          yield transferSigned({ message: signed }, { secrethash: action.meta.secrethash });
          // messageSend LockedTransfer handled by transferSignedRetryMessageEpic
        }),
      );
    }),
    catchError(err => of(transferFailed(err, action.meta))),
  );
}

/**
 * Create an observable to compose and sign a Unlock message/transferUnlocked action
 * As it's an async observable which depends on state and may return an action which changes it,
 * the returned observable must be subscribed in a serialized context that ensures non-concurrent
 * write access to the channel's balance proof (e.g. concatMap)
 *
 * @param state$  Observable of current state
 * @param action  transferUnlock request action to be sent
 * @param signer  RaidenEpicDeps members
 * @returns  Observable of transferUnlocked actions
 */
function makeAndSignUnlock(
  state$: Observable<RaidenState>,
  action: ActionType<typeof transferUnlock>,
  { signer }: RaidenEpicDeps,
) {
  return state$.pipe(
    first(),
    mergeMap(state => {
      const secrethash = action.meta.secrethash;
      if (!(secrethash in state.sent)) throw new Error('unknown transfer');
      const transfer = state.sent[secrethash].transfer,
        channel: Channel | undefined = get(state.channels, [
          transfer.token_network_address,
          transfer.recipient,
        ]);
      // shouldn't happen, channel close clears transfers, but unlock may already have been queued
      if (!channel || channel.state !== ChannelState.open || !channel.own.balanceProof)
        throw new Error('channel gone, not open or no balanceProof');

      let signed$: Observable<Signed<Unlock>>;
      if (state.sent[secrethash].unlock) {
        // unlock already signed, use cached
        signed$ = of(state.sent[secrethash].unlock!);
      } else {
        // don't forget to check after signature too, may have expired by then
        if (transfer.lock.expiration.lte(state.blockNumber)) throw new Error('lock expired');

        const locks: Lock[] = (channel.own.locks || []).filter(l => l.secrethash !== secrethash),
          locksroot = getLocksroot(locks),
          msgId = makeMessageId();

        const message: Unlock = {
          type: MessageType.UNLOCK,
          message_identifier: msgId,
          chain_id: transfer.chain_id,
          token_network_address: transfer.token_network_address,
          channel_identifier: transfer.channel_identifier,
          nonce: channel.own.balanceProof.nonce.add(1) as UInt<8>,
          transferred_amount: channel.own.balanceProof.transferredAmount.add(
            transfer.lock.amount,
          ) as UInt<32>,
          locked_amount: channel.own.balanceProof.lockedAmount.sub(transfer.lock.amount) as UInt<
            32
          >,
          locksroot,
          payment_identifier: transfer.payment_identifier,
          secret: state.secrets[action.meta.secrethash].secret,
        };
        signed$ = from(signMessage(signer, message));
      }

      return signed$.pipe(
        withLatestFrom(state$),
        mergeMap(function*([signed, state]) {
          if (transfer.lock.expiration.lte(state.blockNumber)) throw new Error('lock expired!');
          yield transferUnlocked({ message: signed }, action.meta);
          // messageSend Unlock handled by transferUnlockedRetryMessageEpic
        }),
      );
    }),
    catchError(err => {
      console.error('Error when trying to unlock after SecretReveal', err);
      return EMPTY;
    }),
  );
}

/**
 * Create an observable to compose and sign a LockExpired message/transferExpired action
 * As it's an async observable which depends on state and may return an action which changes it,
 * the returned observable must be subscribed in a serialized context that ensures non-concurrent
 * write access to the channel's balance proof (e.g. concatMap)
 *
 * @param state$  Observable of current state
 * @param action  transfer request action to be sent
 * @param signer  RaidenEpicDeps members
 * @returns  Observable of transferExpired|transferExpireFailed actions
 */
function makeAndSignLockExpired(
  state$: Observable<RaidenState>,
  action: ActionType<typeof transferExpire>,
  { signer }: RaidenEpicDeps,
): Observable<ActionType<typeof transferExpired | typeof transferExpireFailed>> {
  return state$.pipe(
    first(),
    mergeMap(state => {
      const secrethash = action.meta.secrethash;
      if (!(secrethash in state.sent)) throw new Error('unknown transfer');
      const transfer = state.sent[secrethash].transfer,
        channel: Channel | undefined = get(state.channels, [
          transfer.token_network_address,
          transfer.recipient,
        ]);
      // shouldn't happen, channel close clears transfers, but unlock may already have been queued
      if (!channel || channel.state !== ChannelState.open || !channel.own.balanceProof)
        throw new Error('channel gone, not open or no balanceProof');

      let signed$: Observable<Signed<LockExpired>>;
      if (state.sent[secrethash].lockExpired) {
        // unlock already signed, use cached
        signed$ = of(state.sent[secrethash].lockExpired!);
      } else {
        if (transfer.lock.expiration.gte(state.blockNumber))
          throw new Error('lock not yet expired');
        else if (state.sent[secrethash].unlock) throw new Error('transfer already unlocked');

        const locks: Lock[] = (channel.own.locks || []).filter(l => l.secrethash !== secrethash),
          locksroot = getLocksroot(locks),
          msgId = makeMessageId();

        const message: LockExpired = {
          type: MessageType.LOCK_EXPIRED,
          message_identifier: msgId,
          chain_id: transfer.chain_id,
          token_network_address: transfer.token_network_address,
          channel_identifier: transfer.channel_identifier,
          nonce: channel.own.balanceProof.nonce.add(1) as UInt<8>,
          transferred_amount: channel.own.balanceProof.transferredAmount,
          locked_amount: channel.own.balanceProof.lockedAmount.sub(transfer.lock.amount) as UInt<
            32
          >,
          locksroot,
          recipient: transfer.recipient,
          secrethash,
        };
        signed$ = from(signMessage(signer, message));
      }

      return signed$.pipe(
        // messageSend LockExpired handled by transferExpiredRetryMessageEpic
        map(signed => transferExpired({ message: signed }, action.meta)),
      );
    }),
    catchError(err => of(transferExpireFailed(err, action.meta))),
  );
}

/**
 * Serialize creation and signing of BalanceProof-changing messages or actions
 * Actions which change any data in any channel balance proof must only ever be created reading
 * state inside the serialization flow provided by the concatMap, and also be composed and produced
 * inside it (inner, subscribed observable)
 *
 * @param action$  Observable of RaidenActions
 * @param state$  Observable of RaidenStates
 * @param deps  RaidenEpicDeps
 * @returns  Observable of output actions for this epic
 */
export const transferGenerateAndSignEnvelopeMessageEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
  deps: RaidenEpicDeps,
): Observable<
  ActionType<
    | typeof transferSigned
    | typeof transferSecret
    | typeof transferUnlocked
    | typeof transferFailed
    | typeof transferExpired
    | typeof transferExpireFailed
  >
> =>
  combineLatest(getPresences$(action$), state$).pipe(
    publishReplay(1, undefined, presencesStateReplay$ => {
      const [presences$, state$] = splitCombined(presencesStateReplay$);
      return action$.pipe(
        filter(isActionOf([transfer, transferUnlock, transferExpire])),
        concatMap(action =>
          // TODO: add any other BP-changing observable below
          isActionOf(transfer, action)
            ? makeAndSignTransfer(presences$, state$, action, deps)
            : isActionOf(transferUnlock, action)
            ? makeAndSignUnlock(state$, action, deps)
            : isActionOf(transferExpire, action)
            ? makeAndSignLockExpired(state$, action, deps)
            : EMPTY,
        ),
      );
    }),
  );

/**
 * Handles a transferSigned action and retry messageSend until transfer is gone (completed with
 * success or error) OR Processed message for LockedTransfer received.
 * transferSigned for pending LockedTransfer's may be re-emitted on startup for pending transfer,
 * to start retrying sending the message again until stop condition is met.
 *
 * @param action$  Observable of transferSigned actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of messageSend actions
 */
export const transferSignedRetryMessageEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof messageSend>> =>
  state$.pipe(
    publishReplay(1, undefined, state$ =>
      action$.pipe(
        filter(isActionOf(transferSigned)),
        mergeMap(action => {
          const secrethash = action.meta.secrethash,
            signed = action.payload.message,
            send = messageSend({ message: signed }, { address: signed.recipient });
          // emit Send once immediatelly, then wait until respective messageSent, then completes
          const sendOnceAndWaitSent$ = merge(
            of(send),
            action$.pipe(
              filter(
                a =>
                  isActionOf(messageSent, a) &&
                  a.payload.message === send.payload.message &&
                  a.meta.address === send.meta.address,
              ),
              take(1),
              // don't output messageSent, just wait for it before completing
              ignoreElements(),
            ),
          );
          return sendOnceAndWaitSent$.pipe(
            // Resubscribe/retry every 30s after messageSend succeeds with messageSent
            // Notice first (or any) messageSend can wait for a long time before succeeding, as it
            // waits for address's user in transport to be online and joined room before actually
            // sending the message. That's why repeatWhen emits/resubscribe only some time after
            // sendOnceAndWaitSent$ completes, instead of a plain 'interval'
            // TODO: configurable retry delay, possibly use an exponential backoff timeout strat
            repeatWhen(completed$ => completed$.pipe(delay(30e3))),
            // until transfer gone (not in state.sent anymore) OR transferProcessed received
            takeUntil(
              state$.pipe(
                filter(
                  state =>
                    !(secrethash in state.sent) || !!state.sent[secrethash].transferProcessed,
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );

/**
 * Handles a transferUnlocked action and retry messageSend until transfer is gone (completed with
 * success or error).
 * transferUnlocked for pending Unlock's may be re-emitted on startup for pending transfer, to
 * start retrying sending the message again until stop condition is met.
 *
 * @param action$  Observable of transferUnlocked actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of messageSend actions
 */
export const transferUnlockedRetryMessageEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof messageSend>> =>
  state$.pipe(
    publishReplay(1, undefined, state$ =>
      action$.pipe(
        filter(isActionOf(transferUnlocked)),
        withLatestFrom(state$),
        mergeMap(([action, state]) => {
          const secrethash = action.meta.secrethash;
          if (!(secrethash in state.sent) || !state.sent[secrethash].unlock) return EMPTY;
          const unlock = action.payload.message,
            transfer = state.sent[secrethash].transfer,
            send = messageSend({ message: unlock }, { address: transfer.recipient });
          // emit Send once immediatelly, then wait until respective messageSent, then completes
          const sendOnceAndWaitSent$ = merge(
            of(send),
            action$.pipe(
              filter(
                a =>
                  isActionOf(messageSent, a) &&
                  a.payload.message === send.payload.message &&
                  a.meta.address === send.meta.address,
              ),
              take(1),
              // don't output messageSent, just wait for it before completing
              ignoreElements(),
            ),
          );
          return sendOnceAndWaitSent$.pipe(
            // Resubscribe/retry every 30s after messageSend succeeds with messageSent
            // Notice first (or any) messageSend can wait for a long time before succeeding, as it
            // waits for address's user in transport to be online and joined room before actually
            // sending the message. That's why repeatWhen emits/resubscribe only some time after
            // sendOnceAndWaitSent$ completes, instead of a plain 'interval'
            // TODO: configurable retry delay, possibly use an exponential backoff timeout strat
            repeatWhen(completed$ => completed$.pipe(delay(30e3))),
            // until transfer gets cleared, i.e. received Processed for Unlock
            takeUntil(state$.pipe(filter(state => !(secrethash in state.sent)))),
          );
        }),
      ),
    ),
  );

/**
 * Handles a transferExpired action and retry messageSend until transfer is gone (completed with
 * success or error).
 * transferExpired for pending LockExpired's may be re-emitted on startup for pending transfer, to
 * start retrying sending the message again until stop condition is met.
 *
 * @param action$  Observable of transferExpired actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of messageSend actions
 */
export const transferExpiredRetryMessageEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof messageSend>> =>
  state$.pipe(
    publishReplay(1, undefined, state$ =>
      action$.pipe(
        filter(isActionOf(transferExpired)),
        withLatestFrom(state$),
        mergeMap(([action, state]) => {
          const secrethash = action.meta.secrethash;
          if (!(secrethash in state.sent) || !state.sent[secrethash].lockExpired) return EMPTY;
          const lockExpired = action.payload.message,
            send = messageSend(
              { message: lockExpired },
              { address: state.sent[secrethash].transfer.recipient },
            );
          // emit Send once immediatelly, then wait until respective messageSent, then completes
          const sendOnceAndWaitSent$ = merge(
            of(send),
            action$.pipe(
              filter(
                a =>
                  isActionOf(messageSent, a) &&
                  a.payload.message === send.payload.message &&
                  a.meta.address === send.meta.address,
              ),
              take(1),
              // don't output messageSent, just wait for it before completing
              ignoreElements(),
            ),
          );
          return sendOnceAndWaitSent$.pipe(
            // Resubscribe/retry every 30s after messageSend succeeds with messageSent
            // Notice first (or any) messageSend can wait for a long time before succeeding, as it
            // waits for address's user in transport to be online and joined room before actually
            // sending the message. That's why repeatWhen emits/resubscribe only some time after
            // sendOnceAndWaitSent$ completes, instead of a plain 'interval'
            // TODO: configurable retry delay, possibly use an exponential backoff timeout strat
            repeatWhen(completed$ => completed$.pipe(delay(30e3))),
            // until transfer gets cleared, i.e. received Processed for LockExpired
            takeUntil(state$.pipe(filter(state => !(secrethash in state.sent)))),
          );
        }),
      ),
    ),
  );

/**
 * Process newBlocks, emits transferExpire (request to compose&sign LockExpired for a transfer)
 * if pending transfer's lock expired and transfer didn't unlock (succeed) in time
 * Also, emits transferFailed, to notify users that a transfer failed (rejecting potentially
 * pending Promises)
 *
 * @param action$  Observable of newBlock|transferExpired|transferExpireFailed actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of transferExpire|transferFailed actions
 */
export const transferAutoExpireEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferExpire | typeof transferFailed>> =>
  action$.pipe(
    filter(isActionOf(newBlock)),
    withLatestFrom(state$),
    // exhaustMap ignores new blocks while previous request batch is still pending
    exhaustMap(([{ payload: { blockNumber } }, state]) => {
      const requests$: Observable<
        ActionType<typeof transferExpire | typeof transferFailed>
      >[] = [];

      for (const [key, sent] of Object.entries(state.sent)) {
        if (sent.unlock || sent.lockExpired || sent.transfer.lock.expiration.gte(blockNumber))
          continue;
        const secrethash = key as Hash;
        // this observable acts like a Promise: emits request once, completes on success/failure
        const requestAndWait$ = merge(
          // output once tranferExpire
          of(transferExpire(undefined, { secrethash })),
          // but wait until respective success/failure action is seen before completing
          action$.pipe(
            filter(
              a =>
                isActionOf([transferExpired, transferExpireFailed], a) &&
                a.meta.secrethash === secrethash,
            ),
            take(1),
            // don't output success/failure action, just wait for first match to complete
            ignoreElements(),
          ),
        );
        requests$.push(requestAndWait$);
        // notify users that this transfer failed definitely
        requests$.push(
          of(
            transferFailed(
              new Error(`transfer expired at block=${sent.transfer.lock.expiration.toString()}`),
              { secrethash },
            ),
          ),
        );
      }

      // process all requests before completing and restart handling newBlocks (in exhaustMap)
      return merge(...requests$);
    }),
  );

/**
 * Re-queue pending transfer's BalanceProof/Envelope messages for retry on raidenInit
 *
 * @param action$  Observable of raidenInit actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of transferSigned|transferUnlocked actions
 */
export const initQueuePendingEnvelopeMessagesEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<
  ActionType<typeof transferSigned | typeof transferUnlocked | typeof transferExpired>
> =>
  action$.pipe(
    filter(isActionOf(raidenInit)),
    withLatestFrom(state$),
    mergeMap(function*([, state]) {
      // loop over all pending transfers
      for (const [key, sent] of Object.entries(state.sent)) {
        const secrethash = key as Hash,
          transfer = sent.transfer;
        // Processed not received yet for LockedTransfer
        if (!sent.transferProcessed) yield transferSigned({ message: transfer }, { secrethash });
        // already unlocked, but Processed not received yet for Unlock
        // (or else transfer would have been cleared)
        if (sent.unlock) yield transferUnlocked({ message: sent.unlock }, { secrethash });
        // lock expired, but Processed not received yet for LockExpired
        // (or else transfer would have been cleared)
        if (sent.lockExpired) yield transferExpired({ message: sent.lockExpired }, { secrethash });
      }
    }),
  );

/**
 * Handles receiving a signed Processed for some sent LockedTransfer
 * This will persist the Processed reply in transfer state and stop message retry
 *
 * @param action$  Observable of RaidenActions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of output actions for this epic
 */
export const transferProcessedReceivedEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferProcessed>> =>
  action$.pipe(
    filter(isActionOf(messageReceived)),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      const message = action.payload.message;
      if (!message || !Signed(Processed).is(message)) return;
      let secrethash: Hash | undefined = undefined;
      for (const [key, sent] of Object.entries(state.sent)) {
        if (
          sent.transfer.message_identifier.eq(message.message_identifier) &&
          sent.transfer.recipient === action.meta.address
        ) {
          secrethash = key as Hash;
          break;
        }
      }
      if (!secrethash) return;
      yield transferProcessed({ message }, { secrethash });
    }),
  );

/**
 * Handles receiving a signed SecretRequest from target for some sent LockedTransfer
 * Emits a transferSecretRequest action only if all conditions are met
 *
 * @param action$  Observable of RaidenActions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of output actions for this epic
 */
export const transferSecretRequestedEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferSecretRequest>> =>
  action$.pipe(
    filter(isActionOf(messageReceived)),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      const message = action.payload.message;
      if (!message || !Signed(SecretRequest).is(message)) return;
      // transfer gone or we don't know the secret
      if (!(message.secrethash in state.secrets) || !(message.secrethash in state.sent)) return;

      const transfer = state.sent[message.secrethash].transfer;
      if (
        transfer.target !== action.meta.address || // reveal only to target
        transfer.lock.expiration.lte(state.blockNumber) || // don't reveal if expired
        !transfer.payment_identifier.eq(message.payment_identifier) ||
        !transfer.lock.amount.eq(message.amount) ||
        !transfer.lock.expiration.eq(message.expiration)
      )
        return;
      yield transferSecretRequest({ message }, { secrethash: message.secrethash });
    }),
  );

/**
 * Handles a transferSecretRequest action to send the respective secret to target
 * It both emits transferSecretReveal (to persist sent SecretReveal in state and indicate that
 * the secret was revealed and thus the transfer should be assumed as succeeded) as well as
 * triggers sending the message once. New SecretRequests will cause a new transferSecretRequest,
 * which will re-send the cached SecretReveal.
 *
 * @param action$  Observable of transferSecretRequest actions
 * @param state$  Observable of RaidenStates
 * @param signer  RaidenEpicDeps signer
 * @returns  Observable of transferSecretReveal|messageSend actions
 */
export const transferSecretRevealEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
  { signer }: RaidenEpicDeps,
): Observable<ActionType<typeof transferSecretReveal | typeof messageSend>> =>
  state$.pipe(
    publishReplay(1, undefined, state$ =>
      action$.pipe(
        filter(isActionOf(transferSecretRequest)),
        concatMap(action =>
          state$.pipe(
            first(),
            mergeMap(state => {
              if (!(action.meta.secrethash in state.sent)) return EMPTY;
              const target = state.sent[action.meta.secrethash].transfer.target;

              let reveal$: Observable<Signed<SecretReveal>>;
              if (state.sent[action.meta.secrethash].secretReveal)
                reveal$ = of(state.sent[action.meta.secrethash].secretReveal!);
              else {
                const message: SecretReveal = {
                  type: MessageType.SECRET_REVEAL,
                  message_identifier: makeMessageId(),
                  secret: state.secrets[action.meta.secrethash].secret,
                };
                reveal$ = from(signMessage(signer, message));
              }

              return reveal$.pipe(
                mergeMap(function*(message) {
                  yield transferSecretReveal({ message }, action.meta);
                  yield messageSend({ message }, { address: target });
                }),
              );
            }),
          ),
        ),
      ),
    ),
  );

/**
 * Handles receiving a valid SecretReveal from recipient (neighbor/partner)
 * This indicates that the partner knowws the secret, and we should Unlock to avoid going on-chain.
 * The transferUnlock action is a request for the unlocking to be generated and sent.
 *
 * @param action$  Observable of RaidenActions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of output actions for this epic
 */
export const transferSecretRevealedEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferUnlock | typeof transferSecret>> =>
  action$.pipe(
    filter(isActionOf(messageReceived)),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      const message = action.payload.message;
      if (!message || !Signed(SecretReveal).is(message)) return;
      const secrethash = keccak256(message.secret) as Hash;
      if (
        !(secrethash in state.sent) ||
        action.meta.address !== state.sent[secrethash].transfer.recipient ||
        // don't unlock again if already unlocked, retry handled by transferUnlockedRetryMessageEpic
        // in the future, we may avoid retry until Processed, and [re]send once per SecretReveal
        !!state.sent[secrethash].unlock
      )
        return;
      // transferSecret is noop if we already know the secret (e.g. we're the initiator)
      yield transferSecret({ secret: message.secret }, { secrethash });
      // request unlock to be composed, signed & sent to partner
      yield transferUnlock(undefined, { secrethash });
    }),
  );

/**
 * Handles receiving a signed Processed for some sent Unlock
 * It sends the success action for transfer (which resolves any pending Promise), as well sa clears
 * the pending transfer state, as it isn't needed anymore
 *
 * @param action$  Observable of messageReceived actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of transferred|transferClear actions
 */
export const transferUnlockProcessedReceivedEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferred | typeof transferClear>> =>
  action$.pipe(
    filter(isActionOf(messageReceived)),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      const message = action.payload.message;
      if (!message || !Signed(Processed).is(message)) return;
      let secrethash: Hash | undefined;
      for (const [key, sent] of Object.entries(state.sent)) {
        if (
          sent.unlock &&
          sent.unlock.message_identifier.eq(message.message_identifier) &&
          sent.transfer.recipient === action.meta.address
        ) {
          secrethash = key as Hash;
          break;
        }
      }
      if (!secrethash) return;
      yield transferred(
        {
          balanceProof: getBalanceProofFromEnvelopeMessage(state.sent[secrethash].unlock!),
        },
        { secrethash },
      );
      yield transferClear(undefined, { secrethash });
    }),
  );

/**
 * Handles receiving a signed Processed for some sent LockExpired
 * It marks the end of the unhappy case, and clears pending transfer state
 * transferFailed already sent at newBlock handling/transferExpire request time, so just clear
 *
 * @param action$  Observable of RaidenActions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of output actions for this epic
 */
export const transferExpireProcessedClearsEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferClear>> =>
  action$.pipe(
    filter(isActionOf(messageReceived)),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      const message = action.payload.message;
      if (!message || !Signed(Processed).is(message)) return;
      let secrethash: Hash | undefined;
      for (const [key, sent] of Object.entries(state.sent)) {
        if (
          sent.lockExpired &&
          sent.lockExpired.message_identifier.eq(message.message_identifier) &&
          sent.transfer.recipient === action.meta.address
        ) {
          secrethash = key as Hash;
          break;
        }
      }
      if (!secrethash) return;
      yield transferClear(undefined, { secrethash });
    }),
  );

/**
 * Complete or fail any pending transfer for any closing or closed channels
 * The output actions will also clear the pending transfer from state, as well as resolve/reject
 * any [user-facing] pending Promise
 *
 * @param action$  Observable of channelClose|channelClosed actions
 * @param state$  Observable of RaidenStates
 * @returns  Observable of transferred|transferFailed|transferClear actions
 */
export const transferChannelClosedEpic = (
  action$: Observable<RaidenAction>,
  state$: Observable<RaidenState>,
): Observable<ActionType<typeof transferred | typeof transferFailed | typeof transferClear>> =>
  action$.pipe(
    filter(isActionOf([channelClose, channelClosed])),
    withLatestFrom(state$),
    mergeMap(function*([action, state]) {
      for (const [key, sent] of Object.entries(state.sent)) {
        const secrethash = key as Hash,
          transfer = sent.transfer;
        if (
          transfer.token_network_address !== action.meta.tokenNetwork ||
          transfer.recipient !== action.meta.partner
        )
          continue;
        // as we can't know for sure if recipient/partner received the secret or unlock,
        //consider transfer failed iff neither the secret was revealed nor the unlock happened
        if (!sent.secretReveal && !sent.unlock)
          yield transferFailed(new Error(`Channel closed before revealing or unlocking`), {
            secrethash,
          });
        else if (state.sent[secrethash].unlock)
          yield transferred(
            { balanceProof: getBalanceProofFromEnvelopeMessage(state.sent[secrethash].unlock!) },
            { secrethash },
          );
        else yield transferred({}, { secrethash });
        // regardless of success or fail, always clear this transfer, channel gone
        yield transferClear(undefined, { secrethash });
      }
    }),
  );