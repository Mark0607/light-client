/* eslint-disable @typescript-eslint/no-explicit-any */
import { Two } from 'ethers/constants';
import { BigNumber, bigNumberify } from 'ethers/utils';
import { Arrayish, hexlify, isArrayish, hexZeroPad, hexDataLength } from 'ethers/utils/bytes';
import { LosslessNumber, parse } from 'lossless-json';

import { BigNumberC, HexString } from './types';

/**
 * Encode data to hex string of exactly length size (in bytes)
 * Throw if data can't be made to fit in length.
 *
 * @param data - May be of multiple types:
 *      - number|BigNumber: Encoded in the big-endian byte-order and left-zero-padded to length
 *      - string: Must be hex-encoded string of length bytes
 *      - number[] Must be of exactly of length size (left/right-pad it before if needed)
 * @param length - The expected length of the hex string, in bytes
 * @returns HexString byte-array of length
 */
export function encode<S extends number = number>(
  data: number | string | Arrayish | BigNumber,
  length: S,
): HexString<S> {
  let hex: HexString<S>;
  if (typeof data === 'number') data = bigNumberify(data);
  if (BigNumberC.is(data)) {
    if (data.lt(0)) throw new Error('Number is negative');
    if (data.gte(Two.pow(length * 8))) throw new Error('Number too large');
    hex = hexZeroPad(hexlify(data), length) as HexString<S>;
  } else if (typeof data === 'string' || isArrayish(data)) {
    const str = hexlify(data);
    if (hexDataLength(str) !== length)
      throw new Error('Uint8Array or hex string must be of exact length');
    hex = str as HexString<S>;
  } else {
    throw new Error('data is not a HexString or Uint8Array');
  }
  return hex;
}

const isLosslessNumber = (u: unknown): u is LosslessNumber =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  u && (u as any)['isLosslessNumber'] === true;
/**
 * Opportunistic JSON.parse regarding numbers
 * If possible to decode a JSON number as JS number (i.e. value < 2^53) and return 'number',
 * otherwise returns LosslessNumber object, which can be decoded as BigNumber by BigNumberC
 * Throws if handled invalid JSON
 *
 * @param text - JSON string to parse
 * @returns Decoded object
 */
export function losslessParse(text: string): any {
  return parse(text, ({}, value) => {
    if (isLosslessNumber(value)) {
      try {
        return value.valueOf(); // return number, if possible, or throw if > 2^53
      } catch (e) {} // else, pass to return LosslessNumber, which can be decoded by BigNumberC
    }
    return value;
  });
}

export { stringify as losslessStringify } from 'lossless-json';
