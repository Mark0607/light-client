/* eslint-disable @typescript-eslint/camelcase */
import { of, BehaviorSubject, EMPTY, timer } from 'rxjs';
import { first, takeUntil, toArray, pluck } from 'rxjs/operators';
import { bigNumberify, defaultAbiCoder } from 'ethers/utils';
import { Zero, AddressZero, One } from 'ethers/constants';

import { UInt, Int, Address, Signature } from 'raiden-ts/utils/types';
import {
  newBlock,
  tokenMonitored,
  channelOpen,
  channelDeposit,
  channelClose,
} from 'raiden-ts/channels/actions';
import { raidenConfigUpdate } from 'raiden-ts/actions';
import { matrixPresence } from 'raiden-ts/transport/actions';
import { raidenReducer } from 'raiden-ts/reducer';
import {
  pathFindServiceEpic,
  pfsCapacityUpdateEpic,
  pfsServiceRegistryMonitorEpic,
} from 'raiden-ts/path/epics';
import { pathFind, pfsListUpdated, iouPersist, iouClear } from 'raiden-ts/path/actions';
import { RaidenState } from 'raiden-ts/state';
import { messageGlobalSend } from 'raiden-ts/messages/actions';
import { MessageType } from 'raiden-ts/messages/types';
import { losslessStringify } from 'raiden-ts/utils/data';

import { epicFixtures } from '../fixtures';
import { raidenEpicDeps, makeLog } from '../mocks';
import { getLatest$ } from 'raiden-ts/epics';
import { pluckDistinct } from 'raiden-ts/utils/rx';

describe('PFS: pathFindServiceEpic', () => {
  const depsMock = raidenEpicDeps();
  const {
    token,
    tokenNetwork,
    channelId,
    partner,
    target,
    settleTimeout,
    isFirstParticipant,
    txHash,
    state,
    partnerUserId,
    targetUserId,
    fee,
    pfsAddress,
    pfsTokenAddress,
    pfsInfoResponse,
    iou,
  } = epicFixtures(depsMock);

  const openBlock = 121,
    state$ = new BehaviorSubject(state);

  getLatest$(of(raidenConfigUpdate({ config: {} })), state$, depsMock).subscribe(depsMock.latest$);

  afterAll(() => state$.complete());

  const result = { result: [{ path: [partner, target], estimated_fee: 1234 }] },
    fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: jest.fn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async () => result as any,
      ),
      text: jest.fn(async () => losslessStringify(result)),
    }));
  Object.assign(global, { fetch });

  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    // state$ contains a channel opened & deposited with partner
    state$.next(
      [
        tokenMonitored({ token, tokenNetwork, fromBlock: 1 }),
        // a couple of channels with unrelated partners, with larger deposits
        channelOpen.success(
          {
            id: channelId,
            settleTimeout,
            isFirstParticipant,
            txHash,
            txBlock: openBlock,
            confirmed: true,
          },
          { tokenNetwork, partner },
        ),
        channelDeposit.success(
          {
            id: channelId,
            participant: depsMock.address,
            totalDeposit: bigNumberify(50000000) as UInt<32>,
            txHash,
            txBlock: openBlock + 1,
            confirmed: true,
          },
          { tokenNetwork, partner },
        ),
        newBlock({ blockNumber: 126 }),
      ].reduce(raidenReducer, state),
    );
  });

  test('fail unknown tokenNetwork', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork: token, target, value }),
      );

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('unknown tokenNetwork') }),
        { tokenNetwork: token, target, value },
      ),
    );
  });

  test('fail target not available', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: false, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringMatching(/target.*not online/i) }),
        { tokenNetwork, target, value },
      ),
    );
  });

  test('success provided route', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request(
          { paths: [{ path: [depsMock.address, partner, target], fee }] },
          { tokenNetwork, target, value },
        ),
      );

    // self should be taken out of route
    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        { paths: [{ path: [partner, target], fee }] },
        { tokenNetwork, target, value },
      ),
    );
  });

  test('success direct route', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target: partner, value }),
      );

    // self should be taken out of route
    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        { paths: [{ path: [partner], fee: Zero as Int<32> }] },
        { tokenNetwork, target: partner, value },
      ),
    );
  });

  test('success request pfs from action', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request(
          {
            pfs: {
              address: pfsAddress,
              url: state.config.pfs!,
              rtt: 3,
              price: One as UInt<32>,
              token: pfsTokenAddress,
            },
          },
          { tokenNetwork, target, value },
        ),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    let pfsSafetyMargin!: number;
    depsMock.latest$
      .pipe(first())
      .subscribe(({ config }) => (pfsSafetyMargin = config.pfsSafetyMargin));

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        {
          paths: [
            {
              path: [partner, target],
              fee: bigNumberify(1234)
                .mul(pfsSafetyMargin * 1e6)
                .div(1e6) as Int<32>,
            },
          ],
        },
        { tokenNetwork, target, value },
      ),
    );
  });

  test('success request pfs from config', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    let pfsSafetyMargin!: number;
    depsMock.latest$
      .pipe(first())
      .subscribe(({ config }) => (pfsSafetyMargin = config.pfsSafetyMargin));

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        {
          paths: [
            {
              path: [partner, target],
              fee: bigNumberify(1234)
                .mul(pfsSafetyMargin * 1e6)
                .div(1e6) as Int<32>,
            },
          ],
        },
        { tokenNetwork, target, value },
      ),
    );
  });

  test('success request pfs from pfsList', async () => {
    expect.assertions(4);
    // put config.pfs into auto mode
    state$.next(raidenReducer(state$.value, raidenConfigUpdate({ config: { pfs: undefined } })));

    const value = bigNumberify(100) as UInt<32>,
      pfsAddress1 = '0x0800000000000000000000000000000000000091' as Address,
      pfsAddress2 = '0x0800000000000000000000000000000000000092' as Address,
      pfsAddress3 = '0x0800000000000000000000000000000000000093' as Address,
      action$ = of(
        pfsListUpdated({
          pfsList: [pfsAddress1, pfsAddress2, pfsAddress3, pfsAddress],
        }),
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    // pfsAddress1 will be accepted with default https:// schema
    depsMock.serviceRegistryContract.functions.urls.mockResolvedValueOnce('domain.only.url');

    const pfsInfoResponse1 = { ...pfsInfoResponse, payment_address: pfsAddress1 };
    fetch.mockImplementationOnce(
      async () =>
        new Promise(resolve =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                json: jest.fn(async () => pfsInfoResponse1),
                text: jest.fn(async () => losslessStringify(pfsInfoResponse1)),
              }),
            23, // higher rtt for this PFS
          ),
        ),
    );

    // 2 & 3, test sorting by price info
    const pfsInfoResponse2 = { ...pfsInfoResponse, payment_address: pfsAddress2, price_info: 5 };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse2),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse2)),
    });

    const pfsInfoResponse3 = { ...pfsInfoResponse, payment_address: pfsAddress3, price_info: 10 };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse3),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse3)),
    });

    // pfsAddress succeeds main response
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    let pfsSafetyMargin!: number;
    depsMock.latest$
      .pipe(first())
      .subscribe(({ config }) => (pfsSafetyMargin = config.pfsSafetyMargin));

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      iouPersist(
        {
          iou: expect.objectContaining({
            amount: bigNumberify(2),
          }),
        },
        { tokenNetwork, serviceAddress: iou.receiver },
      ),
      pathFind.success(
        {
          paths: [
            {
              path: [partner, target],
              fee: bigNumberify(1234)
                .mul(pfsSafetyMargin * 1e6)
                .div(1e6) as Int<32>,
            },
          ],
        },
        { tokenNetwork, target, value },
      ),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4 + 1 + 1); // 1,2,3,0 addresses, + last iou + paths for chosen one
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/domain.only.url\/.*\/info/),
      expect.anything(),
    );
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/^https:\/\/.*\/paths$/),
      expect.anything(),
    );
  });

  test('fail request pfs from pfsList, empty', async () => {
    expect.assertions(1);
    // put config.pfs into auto mode
    state$.next(raidenReducer(state$.value, raidenConfigUpdate({ config: { pfs: undefined } })));

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        pfsListUpdated({
          pfsList: [pfsAddress, pfsAddress, pfsAddress],
        }),
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    // invalid url
    depsMock.serviceRegistryContract.functions.urls.mockResolvedValueOnce('""');
    // empty url
    depsMock.serviceRegistryContract.functions.urls.mockResolvedValueOnce('');
    // invalid schema
    depsMock.serviceRegistryContract.functions.urls.mockResolvedValueOnce('http://not.https.url');

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({
          message: expect.stringContaining('Could not validate any PFS info'),
        }),
        { tokenNetwork, target, value },
      ),
    );
  });

  test('fail pfs request error', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: jest.fn(async () => ({ error_code: 1337, errors: 'No route' })),
      text: jest.fn(async () => '{ "error_code": 1337, "errors": "No route" }'),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('paths request: code=1337') }),
        { tokenNetwork, target, value },
      ),
    );
  });

  test('fail pfs return success but invalid response format', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    // expected 'result', not 'paths'
    const paths = { paths: [{ path: [partner, target], estimated_fee: 0 }] };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => paths),
      text: jest.fn(async () => losslessStringify(paths)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('Invalid value') }),
        {
          tokenNetwork,
          target,
          value,
        },
      ),
    );
  });

  test('success with free pfs and valid route', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    const freePfsInfoResponse = { ...pfsInfoResponse, price_info: 0 };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => freePfsInfoResponse),
      text: jest.fn(async () => losslessStringify(freePfsInfoResponse)),
    });

    const result = {
      result: [
        // valid route
        { path: [partner, target], estimated_fee: 1 },
      ],
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => result),
      text: jest.fn(async () => losslessStringify(result)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        { paths: [{ path: [partner, target], fee: bigNumberify(1) as Int<32> }] },
        { tokenNetwork, target, value },
      ),
    );
  });

  test('success with cached iou and valid route', async () => {
    expect.assertions(1);

    state$.next(
      raidenReducer(
        state$.value,
        iouPersist({ iou }, { tokenNetwork, serviceAddress: iou.receiver }),
      ),
    );

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    const result = {
      result: [
        // valid route
        { path: [partner, target], estimated_fee: 1 },
      ],
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => result),
      text: jest.fn(async () => losslessStringify(result)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      iouPersist(
        {
          iou: expect.objectContaining({
            amount: bigNumberify(102),
          }),
        },
        { tokenNetwork, serviceAddress: iou.receiver },
      ),
      pathFind.success(
        { paths: [{ path: [partner, target], fee: bigNumberify(1) as Int<32> }] },
        { tokenNetwork, target, value },
      ),
    ]);
  });

  test('success from config but filter out invalid pfs result routes', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    const result = {
      result: [
        // token isn't a valid channel, should be removed from output
        { path: [token, target], estimated_fee: 0 },
        // another route going through token, also should be removed
        { path: [token, partner, target], estimated_fee: 0 },
        // valid route
        { path: [partner, target], estimated_fee: 1 },
        // another "valid" route through partner, filtered out because different fee
        { path: [partner, token, target], estimated_fee: 2 },
        // another invalid route, but we already selected partner first
        { path: [tokenNetwork, target], estimated_fee: 3 },
      ],
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => result),
      text: jest.fn(async () => losslessStringify(result)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.success(
        { paths: [{ path: [partner, target], fee: bigNumberify(1) as Int<32> }] },
        { tokenNetwork, target, value },
      ),
    );
  });

  test('fail channel not open', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    state$.next(
      [
        channelClose.success(
          { id: channelId, participant: partner, txHash, txBlock: 126, confirmed: true },
          { tokenNetwork, partner },
        ),
      ].reduce(raidenReducer, state$.value),
    );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 404,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    const result = { result: [{ path: [partner, target], estimated_fee: 1 }] };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => result),
      text: jest.fn(async () => losslessStringify(result)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('no valid routes found') }),
        {
          tokenNetwork,
          target,
          value,
        },
      ),
    );
  });

  test('fail provided route but not enough capacity', async () => {
    expect.assertions(1);

    const value = bigNumberify(80000000) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request(
          { paths: [{ path: [depsMock.address, partner, target], fee }] },
          { tokenNetwork, target, value },
        ),
      );

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('no valid routes found') }),
        { tokenNetwork, target, value },
      ),
    );
  });

  test('fail no route between nodes', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    const lastIOUResult = {
      last_iou: {
        ...iou,
        chain_id: UInt(32).encode(iou.chain_id),
        amount: UInt(32).encode(iou.amount),
        expiration_block: UInt(32).encode(iou.expiration_block),
      },
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => lastIOUResult),
      text: jest.fn(async () => losslessStringify(lastIOUResult)),
    });

    const errorResult = {
      errors: 'No route between nodes found.',
      error_code: 2201,
    };

    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: jest.fn(async () => errorResult),
      text: jest.fn(async () => losslessStringify(errorResult)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      iouPersist(
        {
          iou: expect.objectContaining({
            amount: bigNumberify(102),
          }),
        },
        { tokenNetwork, serviceAddress: iou.receiver },
      ),
      pathFind.failure(
        expect.objectContaining({
          message: expect.stringContaining('No route between nodes found.'),
        }),
        { tokenNetwork, target, value },
      ),
    ]);
  });

  test('fail last iou server error', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: jest.fn(async () => {
        /* error */
      }),
      text: jest.fn(async () => losslessStringify({})),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      pathFind.failure(
        expect.objectContaining({
          message: expect.stringContaining('last IOU request: code=500'),
        }),
        { tokenNetwork, target, value },
      ),
    ]);
  });

  test('fail last iou invalid signature', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    const lastIOUResult = {
      last_iou: {
        ...iou,
        chain_id: UInt(32).encode(iou.chain_id),
        amount: UInt(32).encode(iou.amount),
        expiration_block: UInt(32).encode(iou.expiration_block),
        signature: '0x87ea2a9c6834513dcabfca011c4422eb02a824b8bbbfc8f555d6a6dd2ebbbe953e1a47ad27b9715d8c8cf2da833f7b7d6c8f9bdb997591b7234999901f042caf1f' as Signature,
      },
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => lastIOUResult),
      text: jest.fn(async () => losslessStringify(lastIOUResult)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      pathFind.failure(
        expect.objectContaining({
          message: expect.stringContaining('last iou signature mismatch'),
        }),
        { tokenNetwork, target, value },
      ),
    ]);
  });

  test('fail iou already claimed', async () => {
    expect.assertions(1);

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => pfsInfoResponse),
      text: jest.fn(async () => losslessStringify(pfsInfoResponse)),
    });

    const lastIOUResult = {
      last_iou: {
        ...iou,
        chain_id: UInt(32).encode(iou.chain_id),
        amount: UInt(32).encode(iou.amount),
        expiration_block: UInt(32).encode(iou.expiration_block),
      },
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn(async () => lastIOUResult),
      text: jest.fn(async () => losslessStringify(lastIOUResult)),
    });

    const result = {
      errors:
        'The IOU is already claimed. Please start new session with different `expiration_block`.',
      error_code: 2105,
    };

    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: jest.fn(async () => result),
      text: jest.fn(async () => losslessStringify(result)),
    });

    await expect(
      pathFindServiceEpic(action$, state$, depsMock)
        .pipe(toArray())
        .toPromise(),
    ).resolves.toMatchObject([
      iouClear(undefined, { tokenNetwork, serviceAddress: iou.receiver }),
      pathFind.failure(
        expect.objectContaining({
          message: expect.stringContaining('The IOU is already claimed'),
        }),
        { tokenNetwork, target, value },
      ),
    ]);
  });

  test('fail pfs disabled', async () => {
    expect.assertions(2);

    // disable pfs
    state$.next(raidenReducer(state$.value, raidenConfigUpdate({ config: { pfs: null } })));

    await expect(
      depsMock.latest$.pipe(pluckDistinct('config', 'pfs'), first()).toPromise(),
    ).resolves.toBeNull();

    const value = bigNumberify(100) as UInt<32>,
      action$ = of(
        matrixPresence.success(
          { userId: partnerUserId, available: true, ts: Date.now() },
          { address: partner },
        ),
        matrixPresence.success(
          { userId: targetUserId, available: true, ts: Date.now() },
          { address: target },
        ),
        pathFind.request({}, { tokenNetwork, target, value }),
      );

    await expect(
      pathFindServiceEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toMatchObject(
      pathFind.failure(
        expect.objectContaining({ message: expect.stringContaining('PFS disabled') }),
        { tokenNetwork, target, value },
      ),
    );
  });
});

describe('PFS: pfsCapacityUpdateEpic', () => {
  const depsMock = raidenEpicDeps();
  const {
    token,
    tokenNetwork,
    channelId,
    partner,
    settleTimeout,
    isFirstParticipant,
    txHash,
    state,
  } = epicFixtures(depsMock);

  const openBlock = 121;
  let openedState: RaidenState;

  /**
   * this will leave/reset transferingState, signedTransfer as a state with a channel and pending
   * transfer
   */
  beforeEach(async () => {
    openedState = [
      tokenMonitored({ token, tokenNetwork, fromBlock: 1 }),
      channelOpen.success(
        {
          id: channelId,
          settleTimeout,
          isFirstParticipant,
          txHash,
          txBlock: openBlock,
          confirmed: true,
        },
        { tokenNetwork, partner },
      ),
      newBlock({ blockNumber: 125 }),
    ].reduce(raidenReducer, state);
  });

  test('own channelDeposit.success triggers capacity update', async () => {
    expect.assertions(1);

    const deposit = bigNumberify(500) as UInt<32>,
      action = channelDeposit.success(
        {
          id: channelId,
          participant: depsMock.address,
          totalDeposit: deposit,
          txHash,
          txBlock: openBlock + 1,
          confirmed: true,
        },
        { tokenNetwork, partner },
      ),
      action$ = of(action),
      state$ = new BehaviorSubject<RaidenState>([action].reduce(raidenReducer, openedState));

    let pfsRoom!: string;
    depsMock.latest$.pipe(first()).subscribe(({ config }) => (pfsRoom = config.pfsRoom!));

    await expect(pfsCapacityUpdateEpic(action$, state$, depsMock).toPromise()).resolves.toEqual(
      messageGlobalSend(
        {
          message: expect.objectContaining({
            type: MessageType.PFS_CAPACITY_UPDATE,
            updating_participant: depsMock.address,
            other_participant: partner,
            updating_capacity: deposit,
            signature: expect.any(String),
          }),
        },
        { roomName: expect.stringMatching(pfsRoom) },
      ),
    );
  });

  test("signature fail isn't fatal", async () => {
    expect.assertions(2);

    const deposit = bigNumberify(500) as UInt<32>,
      action = channelDeposit.success(
        {
          id: channelId,
          participant: depsMock.address,
          totalDeposit: deposit,
          txHash,
          txBlock: openBlock + 1,
          confirmed: true,
        },
        { tokenNetwork, partner },
      ),
      action$ = of(action),
      state$ = new BehaviorSubject<RaidenState>([action].reduce(raidenReducer, openedState));

    const signerSpy = jest.spyOn(depsMock.signer, 'signMessage');
    signerSpy.mockRejectedValueOnce(new Error('Signature rejected'));

    await expect(
      pfsCapacityUpdateEpic(action$, state$, depsMock).toPromise(),
    ).resolves.toBeUndefined();

    expect(signerSpy).toHaveBeenCalledTimes(1);
    signerSpy.mockRestore();
  });
});

describe('PFS: pfsServiceRegistryMonitorEpic', () => {
  const depsMock = raidenEpicDeps(),
    { state, pfsAddress } = epicFixtures(depsMock),
    state$ = new BehaviorSubject(state);

  getLatest$(of(raidenConfigUpdate({ config: {} })), state$, depsMock).subscribe(depsMock.latest$);

  afterAll(() => state$.complete());

  beforeEach(() => {
    state$.next(state); // reset state
  });

  test('success', async () => {
    expect.assertions(2);

    // enable config.pfs auto (undefined)
    state$.next(raidenReducer(state$.value, raidenConfigUpdate({ config: { pfs: undefined } })));

    const validTill = bigNumberify(Math.floor(Date.now() / 1000) + 86400), // tomorrow
      registeredEncoded = defaultAbiCoder.encode(
        ['uint256', 'uint256', 'address'],
        [validTill, Zero, AddressZero],
      ),
      expiredEncoded = defaultAbiCoder.encode(
        ['uint256', 'uint256', 'address'],
        [bigNumberify(Math.floor(Date.now() / 1000) - 86400), Zero, AddressZero],
      ),
      expiringSoonEncoded = defaultAbiCoder.encode(
        ['uint256', 'uint256', 'address'],
        [bigNumberify(Math.floor(Date.now() / 1000) + 1), Zero, AddressZero],
      );

    await expect(
      depsMock.config$.pipe(pluck('pfs'), first()).toPromise(),
    ).resolves.toBeUndefined();
    const promise = pfsServiceRegistryMonitorEpic(EMPTY, state$, depsMock)
      .pipe(first())
      .toPromise();

    // expired
    depsMock.provider.emit(
      depsMock.serviceRegistryContract.filters.RegisteredService(null, null, null, null),
      makeLog({
        blockNumber: 115,
        filter: depsMock.serviceRegistryContract.filters.RegisteredService(
          pfsAddress,
          null,
          null,
          null,
        ),
        data: expiredEncoded,
      }),
    );

    // new event from previous expired service, but now valid=true
    depsMock.provider.emit(
      depsMock.serviceRegistryContract.filters.RegisteredService(null, null, null, null),
      makeLog({
        blockNumber: 116,
        filter: depsMock.serviceRegistryContract.filters.RegisteredService(
          pfsAddress,
          null,
          null,
          null,
        ),
        data: registeredEncoded, // non-indexed valid_till, deposit, deposit_contract
      }),
    );

    // duplicated event, but valid
    depsMock.provider.emit(
      depsMock.serviceRegistryContract.filters.RegisteredService(null, null, null, null),
      makeLog({
        blockNumber: 116,
        filter: depsMock.serviceRegistryContract.filters.RegisteredService(
          pfsAddress,
          null,
          null,
          null,
        ),
        data: registeredEncoded, // non-indexed valid_till, deposit, deposit_contract
      }),
    );

    // expires while waiting, doesn't make it to the list
    depsMock.provider.emit(
      depsMock.serviceRegistryContract.filters.RegisteredService(null, null, null, null),
      makeLog({
        blockNumber: 117,
        filter: depsMock.serviceRegistryContract.filters.RegisteredService(
          '0x0700000000000000000000000000000000000006',
          null,
          null,
          null,
        ),
        data: expiringSoonEncoded,
      }),
    );

    await expect(promise).resolves.toMatchObject({
      type: pfsListUpdated.type,
      payload: { pfsList: [pfsAddress] },
    });
  });

  test('noop if config.pfs is set', async () => {
    expect.assertions(2);
    await expect(depsMock.config$.pipe(pluck('pfs'), first()).toPromise()).resolves.toBeDefined();

    const validTill = bigNumberify(Math.floor(Date.now() / 1000) + 86400), // tomorrow
      registeredEncoded = defaultAbiCoder.encode(
        ['uint256', 'uint256', 'address'],
        [validTill, Zero, AddressZero],
      );

    const promise = pfsServiceRegistryMonitorEpic(EMPTY, state$, depsMock)
      .pipe(takeUntil(timer(1500)))
      .toPromise();

    depsMock.provider.emit(
      depsMock.serviceRegistryContract.filters.RegisteredService(null, null, null, null),
      makeLog({
        blockNumber: 116,
        filter: depsMock.serviceRegistryContract.filters.RegisteredService(
          pfsAddress,
          null,
          null,
          null,
        ),
        data: registeredEncoded, // non-indexed valid_till, deposit, deposit_contract
      }),
    );

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('PFS: reducer', () => {
  test('persist and clear', () => {
    expect.assertions(2);

    const depsMock = raidenEpicDeps();
    const { iou, state, tokenNetwork } = epicFixtures(depsMock);

    const newState = raidenReducer(
      state,
      iouPersist({ iou }, { tokenNetwork, serviceAddress: iou.receiver }),
    );

    expect(newState.path.iou).toMatchObject({
      [tokenNetwork]: {
        [iou.receiver]: iou,
      },
    });

    const lastState = raidenReducer(
      newState,
      iouClear(undefined, { tokenNetwork, serviceAddress: iou.receiver }),
    );

    expect(lastState.path.iou).toMatchObject({
      [tokenNetwork]: {},
    });
  });
});
