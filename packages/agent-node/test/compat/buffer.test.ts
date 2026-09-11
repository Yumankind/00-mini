/**
 * Ported from macaly/almostnode (MIT, 6ab61f31) — 92 cases; see test/compat/LICENSE-almostnode
 *
 * almostnode is another "Node in a browser tab" runtime, and its node-compat corpus is adapted in
 * turn from Node's own `test/parallel`. The cases are theirs, case names included; what they run
 * against is ours — src/modules/core.ts's `Buffer` (the `buffer` package, the one npm is tested against).
 *
 * A case this package does not pass is `it.skip`ped with the gap named in the reason, never deleted
 * and never quietly rewritten to match what we do: the count of skips in `test/compat/SCOREBOARD.md`
 * is the scoreboard, and a skip that disappears is a shim that got better.
 */

import { describe, it, expect, beforeEach, afterEach, vi, test } from "vitest";
import { Buffer as NodeBuffer } from "../../src/modules/core.js";
import { api, assert, bufferEquals } from "./common.js";

// `api()` because the `buffer` package's own .d.ts is narrower than the runtime object: isEncoding,
// copy, compare and the write* family are all there and none of them is typed.
const Buffer = api(NodeBuffer);

describe('Buffer module (Node.js compat)', () => {
  describe('Buffer.from()', () => {
    describe('from string', () => {
      it('should create buffer from UTF-8 string (default)', () => {
        const buf = Buffer.from('hello');
        assert.strictEqual(buf.length, 5);
        assert.strictEqual(buf.toString(), 'hello');
      });

      it('should create buffer from UTF-8 string (explicit)', () => {
        const buf = Buffer.from('hello', 'utf8');
        assert.strictEqual(buf.length, 5);
        assert.strictEqual(buf.toString('utf8'), 'hello');
      });

      it('should create buffer from UTF-8 string (utf-8)', () => {
        const buf = Buffer.from('hello', 'utf-8');
        assert.strictEqual(buf.length, 5);
        assert.strictEqual(buf.toString('utf-8'), 'hello');
      });

      it('should handle unicode characters', () => {
        const buf = Buffer.from('\u00bd + \u00bc = \u00be');
        assert.strictEqual(buf.toString(), '\u00bd + \u00bc = \u00be');
      });

      it('should handle emoji', () => {
        const buf = Buffer.from('Hello \uD83D\uDE00');
        assert.strictEqual(buf.toString(), 'Hello \uD83D\uDE00');
      });
    });

    describe('from hex string', () => {
      it('should decode hex string', () => {
        const buf = Buffer.from('68656c6c6f', 'hex');
        assert.strictEqual(buf.toString(), 'hello');
      });

      it('should decode uppercase hex', () => {
        const buf = Buffer.from('48454C4C4F', 'hex');
        assert.strictEqual(buf.toString(), 'HELLO');
      });

      it('should handle empty hex string', () => {
        const buf = Buffer.from('', 'hex');
        assert.strictEqual(buf.length, 0);
      });
    });

    describe('from base64 string', () => {
      it('should decode base64 string', () => {
        const buf = Buffer.from('aGVsbG8=', 'base64');
        assert.strictEqual(buf.toString(), 'hello');
      });

      it('should handle base64 without padding', () => {
        const buf = Buffer.from('aGVsbG8', 'base64');
        assert.strictEqual(buf.toString(), 'hello');
      });

      // SKIP: the `buffer` package (6.0.3) has no base64url encoding — Node added it in 15 and this is the version npm is tested against
      it.skip('should decode base64url string', () => {
        const buf = Buffer.from('aGVsbG8', 'base64url');
        assert.strictEqual(buf.toString(), 'hello');
      });

      // SKIP: the `buffer` package (6.0.3) has no base64url encoding — Node added it in 15 and this is the version npm is tested against
      it.skip('should handle base64url special characters', () => {
        // Base64url uses - instead of + and _ instead of /
        const standard = Buffer.from('+/', 'base64');
        const url = Buffer.from('-_', 'base64url');
        assert.ok(bufferEquals(standard, url));
      });
    });

    describe('from latin1/binary string', () => {
      it('should decode latin1 string', () => {
        const buf = Buffer.from('hello', 'latin1');
        assert.strictEqual(buf.toString('latin1'), 'hello');
      });

      it('should decode binary string', () => {
        const buf = Buffer.from('hello', 'binary');
        assert.strictEqual(buf.toString('binary'), 'hello');
      });
    });

    describe('from array', () => {
      it('should create buffer from array of bytes', () => {
        const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
        assert.strictEqual(buf.toString(), 'hello');
      });

      it('should handle empty array', () => {
        const buf = Buffer.from([]);
        assert.strictEqual(buf.length, 0);
      });

      it('should clamp values to 0-255', () => {
        const buf = Buffer.from([256, -1, 128]);
        assert.strictEqual(buf[0], 0); // 256 % 256 = 0
        assert.strictEqual(buf[1], 255); // -1 becomes 255
        assert.strictEqual(buf[2], 128);
      });
    });

    describe('from Uint8Array', () => {
      it('should create buffer from Uint8Array', () => {
        const arr = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
        const buf = Buffer.from(arr);
        assert.strictEqual(buf.toString(), 'hello');
      });

      it('should create buffer from ArrayBuffer', () => {
        const arr = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
        const buf = Buffer.from(arr.buffer);
        assert.strictEqual(buf.toString(), 'hello');
      });
    });
  });

  describe('Buffer.alloc()', () => {
    it('should allocate buffer of specified size', () => {
      const buf = Buffer.alloc(10);
      assert.strictEqual(buf.length, 10);
    });

    it('should zero-fill by default', () => {
      const buf = Buffer.alloc(10);
      for (let i = 0; i < buf.length; i++) {
        assert.strictEqual(buf[i], 0);
      }
    });

    it('should fill with specified value', () => {
      const buf = Buffer.alloc(10, 0x41);
      for (let i = 0; i < buf.length; i++) {
        assert.strictEqual(buf[i], 0x41);
      }
    });

    it('should handle size 0', () => {
      const buf = Buffer.alloc(0);
      assert.strictEqual(buf.length, 0);
    });
  });

  describe('Buffer.allocUnsafe()', () => {
    it('should allocate buffer of specified size', () => {
      const buf = Buffer.allocUnsafe(10);
      assert.strictEqual(buf.length, 10);
    });

    it('should handle size 0', () => {
      const buf = Buffer.allocUnsafe(0);
      assert.strictEqual(buf.length, 0);
    });
  });

  describe('Buffer.concat()', () => {
    it('should concatenate buffers', () => {
      const buf1 = Buffer.from('hello');
      const buf2 = Buffer.from(' ');
      const buf3 = Buffer.from('world');
      const combined = Buffer.concat([buf1, buf2, buf3]);
      assert.strictEqual(combined.toString(), 'hello world');
    });

    it('should handle empty array', () => {
      const buf = Buffer.concat([]);
      assert.strictEqual(buf.length, 0);
    });

    it('should handle single buffer', () => {
      const buf1 = Buffer.from('hello');
      const combined = Buffer.concat([buf1]);
      assert.strictEqual(combined.toString(), 'hello');
    });

    it('should handle Uint8Arrays', () => {
      const arr1 = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
      const arr2 = new Uint8Array([0x21]);
      const combined = Buffer.concat([arr1, arr2]);
      assert.strictEqual(combined.toString(), 'hello!');
    });
  });

  describe('Buffer.isBuffer()', () => {
    it('should return true for Buffer', () => {
      assert.strictEqual(Buffer.isBuffer(Buffer.from('test')), true);
      assert.strictEqual(Buffer.isBuffer(Buffer.alloc(5)), true);
    });

    // SKIP: almostnode's isBuffer() answers true for a bare Uint8Array; Node's answers false, and so do we
    it.skip('should return true for Uint8Array (browser compat)', () => {
      // In our shim, Uint8Arrays are also considered buffers
      assert.strictEqual(Buffer.isBuffer(new Uint8Array(5)), true);
    });

    it('should return false for non-buffers', () => {
      assert.strictEqual(Buffer.isBuffer('string'), false);
      assert.strictEqual(Buffer.isBuffer(123), false);
      assert.strictEqual(Buffer.isBuffer(null), false);
      assert.strictEqual(Buffer.isBuffer(undefined), false);
      assert.strictEqual(Buffer.isBuffer({}), false);
      assert.strictEqual(Buffer.isBuffer([]), false);
    });
  });

  describe('Buffer.isEncoding()', () => {
    // SKIP: isEncoding('base64url') — the same `buffer` package gap
    it.skip('should return true for supported encodings', () => {
      assert.strictEqual(Buffer.isEncoding('utf8'), true);
      assert.strictEqual(Buffer.isEncoding('utf-8'), true);
      assert.strictEqual(Buffer.isEncoding('hex'), true);
      assert.strictEqual(Buffer.isEncoding('base64'), true);
      assert.strictEqual(Buffer.isEncoding('base64url'), true);
      assert.strictEqual(Buffer.isEncoding('latin1'), true);
      assert.strictEqual(Buffer.isEncoding('binary'), true);
      assert.strictEqual(Buffer.isEncoding('ascii'), true);
    });

    it('should return false for unsupported encodings', () => {
      assert.strictEqual(Buffer.isEncoding('unknown'), false);
      assert.strictEqual(Buffer.isEncoding(''), false);
    });

    it('should be case-insensitive', () => {
      assert.strictEqual(Buffer.isEncoding('UTF8'), true);
      assert.strictEqual(Buffer.isEncoding('HEX'), true);
      assert.strictEqual(Buffer.isEncoding('Base64'), true);
    });
  });

  describe('Buffer.byteLength()', () => {
    it('should return byte length for UTF-8', () => {
      assert.strictEqual(Buffer.byteLength('hello'), 5);
      assert.strictEqual(Buffer.byteLength('hello', 'utf8'), 5);
    });

    it('should handle multi-byte characters', () => {
      // UTF-8 encoding of emoji is 4 bytes
      const emoji = '\uD83D\uDE00';
      assert.strictEqual(Buffer.byteLength(emoji), 4);
    });

    it('should return byte length for hex', () => {
      assert.strictEqual(Buffer.byteLength('68656c6c6f', 'hex'), 5);
    });

    it('should return byte length for base64', () => {
      // 'aGVsbG8=' decodes to 'hello' (5 bytes)
      assert.strictEqual(Buffer.byteLength('aGVsbG8=', 'base64'), 5);
    });
  });

  describe('Buffer#toString()', () => {
    it('should convert to UTF-8 by default', () => {
      const buf = Buffer.from('hello');
      assert.strictEqual(buf.toString(), 'hello');
    });

    it('should convert to hex', () => {
      const buf = Buffer.from('hello');
      assert.strictEqual(buf.toString('hex'), '68656c6c6f');
    });

    it('should convert to base64', () => {
      const buf = Buffer.from('hello');
      assert.strictEqual(buf.toString('base64'), 'aGVsbG8=');
    });

    // SKIP: the `buffer` package (6.0.3) has no base64url encoding — Node added it in 15 and this is the version npm is tested against
    it.skip('should convert to base64url', () => {
      const buf = Buffer.from('hello');
      const base64url = buf.toString('base64url');
      // base64url should not contain + / =
      assert.ok(!base64url.includes('+'));
      assert.ok(!base64url.includes('/'));
      assert.ok(!base64url.includes('='));
    });

    it('should convert to latin1', () => {
      const buf = Buffer.from([0xc0, 0xc1, 0xc2]);
      const str = buf.toString('latin1');
      assert.strictEqual(str.charCodeAt(0), 0xc0);
      assert.strictEqual(str.charCodeAt(1), 0xc1);
      assert.strictEqual(str.charCodeAt(2), 0xc2);
    });
  });

  describe('Buffer#slice() and #subarray()', () => {
    it('should slice buffer', () => {
      const buf = Buffer.from('hello world');
      const slice = buf.slice(0, 5);
      assert.strictEqual(slice.toString(), 'hello');
    });

    it('should handle negative indices', () => {
      const buf = Buffer.from('hello world');
      const slice = buf.slice(-5);
      assert.strictEqual(slice.toString(), 'world');
    });

    it('should subarray buffer', () => {
      const buf = Buffer.from('hello world');
      const sub = buf.subarray(6, 11);
      assert.strictEqual(sub.toString(), 'world');
    });
  });

  describe('Buffer#write()', () => {
    it('should write string to buffer', () => {
      const buf = Buffer.alloc(10);
      buf.write('hello');
      assert.strictEqual(buf.slice(0, 5).toString(), 'hello');
    });

    it('should write at offset', () => {
      const buf = Buffer.alloc(10);
      buf.write('world', 5);
      assert.strictEqual(buf.slice(5, 10).toString(), 'world');
    });

    it('should return bytes written', () => {
      const buf = Buffer.alloc(10);
      const written = buf.write('hello');
      assert.strictEqual(written, 5);
    });
  });

  describe('Buffer#copy()', () => {
    it('should copy to target buffer', () => {
      const src = Buffer.from('hello');
      const dst = Buffer.alloc(10);
      src.copy(dst);
      assert.strictEqual(dst.slice(0, 5).toString(), 'hello');
    });

    it('should copy with target start', () => {
      const src = Buffer.from('hello');
      const dst = Buffer.alloc(10);
      src.copy(dst, 5);
      assert.strictEqual(dst.slice(5, 10).toString(), 'hello');
    });

    it('should copy partial source', () => {
      const src = Buffer.from('hello world');
      const dst = Buffer.alloc(5);
      src.copy(dst, 0, 6, 11);
      assert.strictEqual(dst.toString(), 'world');
    });

    it('should return bytes copied', () => {
      const src = Buffer.from('hello');
      const dst = Buffer.alloc(10);
      const copied = src.copy(dst);
      assert.strictEqual(copied, 5);
    });
  });

  describe('Buffer#compare() and #equals()', () => {
    it('should compare equal buffers', () => {
      const buf1 = Buffer.from('ABC');
      const buf2 = Buffer.from('ABC');
      assert.strictEqual(buf1.compare(buf2), 0);
      assert.strictEqual(buf1.equals(buf2), true);
    });

    it('should compare less than', () => {
      const buf1 = Buffer.from('ABC');
      const buf2 = Buffer.from('ABD');
      assert.strictEqual(buf1.compare(buf2), -1);
      assert.strictEqual(buf1.equals(buf2), false);
    });

    it('should compare greater than', () => {
      const buf1 = Buffer.from('ABD');
      const buf2 = Buffer.from('ABC');
      assert.strictEqual(buf1.compare(buf2), 1);
      assert.strictEqual(buf1.equals(buf2), false);
    });

    it('should compare different lengths', () => {
      const buf1 = Buffer.from('ABC');
      const buf2 = Buffer.from('ABCD');
      assert.strictEqual(buf1.compare(buf2), -1);
    });
  });

  describe('Buffer#toJSON()', () => {
    it('should return JSON representation', () => {
      const buf = Buffer.from('hello');
      const json = buf.toJSON();
      assert.strictEqual(json.type, 'Buffer');
      assert.deepStrictEqual(json.data, [104, 101, 108, 108, 111]);
    });
  });

  describe('Integer read methods', () => {
    describe('unsigned integers', () => {
      it('should read UInt8', () => {
        const buf = Buffer.from([0x12, 0x34, 0x56]);
        assert.strictEqual(buf.readUInt8(0), 0x12);
        assert.strictEqual(buf.readUInt8(1), 0x34);
        assert.strictEqual(buf.readUInt8(2), 0x56);
      });

      it('should read UInt16BE', () => {
        const buf = Buffer.from([0x12, 0x34]);
        assert.strictEqual(buf.readUInt16BE(0), 0x1234);
      });

      it('should read UInt16LE', () => {
        const buf = Buffer.from([0x34, 0x12]);
        assert.strictEqual(buf.readUInt16LE(0), 0x1234);
      });

      it('should read UInt32BE', () => {
        const buf = Buffer.from([0x12, 0x34, 0x56, 0x78]);
        assert.strictEqual(buf.readUInt32BE(0), 0x12345678);
      });

      it('should read UInt32LE', () => {
        const buf = Buffer.from([0x78, 0x56, 0x34, 0x12]);
        assert.strictEqual(buf.readUInt32LE(0), 0x12345678);
      });
    });

    describe('signed integers', () => {
      it('should read Int8 positive', () => {
        const buf = Buffer.from([0x7f]);
        assert.strictEqual(buf.readInt8(0), 127);
      });

      it('should read Int8 negative', () => {
        const buf = Buffer.from([0xff]);
        assert.strictEqual(buf.readInt8(0), -1);
      });

      it('should read Int16BE', () => {
        const buf = Buffer.from([0xff, 0xfe]);
        assert.strictEqual(buf.readInt16BE(0), -2);
      });

      it('should read Int16LE', () => {
        const buf = Buffer.from([0xfe, 0xff]);
        assert.strictEqual(buf.readInt16LE(0), -2);
      });

      it('should read Int32BE', () => {
        const buf = Buffer.from([0xff, 0xff, 0xff, 0xfe]);
        assert.strictEqual(buf.readInt32BE(0), -2);
      });

      it('should read Int32LE', () => {
        const buf = Buffer.from([0xfe, 0xff, 0xff, 0xff]);
        assert.strictEqual(buf.readInt32LE(0), -2);
      });
    });
  });

  describe('Integer write methods', () => {
    describe('unsigned integers', () => {
      it('should write UInt8', () => {
        const buf = Buffer.alloc(1);
        buf.writeUInt8(0x12, 0);
        assert.strictEqual(buf[0], 0x12);
      });

      it('should write UInt16BE', () => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(0x1234, 0);
        assert.strictEqual(buf[0], 0x12);
        assert.strictEqual(buf[1], 0x34);
      });

      it('should write UInt16LE', () => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(0x1234, 0);
        assert.strictEqual(buf[0], 0x34);
        assert.strictEqual(buf[1], 0x12);
      });

      it('should write UInt32BE', () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(0x12345678, 0);
        assert.strictEqual(buf[0], 0x12);
        assert.strictEqual(buf[1], 0x34);
        assert.strictEqual(buf[2], 0x56);
        assert.strictEqual(buf[3], 0x78);
      });

      it('should write UInt32LE', () => {
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(0x12345678, 0);
        assert.strictEqual(buf[0], 0x78);
        assert.strictEqual(buf[1], 0x56);
        assert.strictEqual(buf[2], 0x34);
        assert.strictEqual(buf[3], 0x12);
      });
    });

    describe('signed integers', () => {
      it('should write Int8', () => {
        const buf = Buffer.alloc(1);
        buf.writeInt8(-1, 0);
        assert.strictEqual(buf[0], 0xff);
      });

      it('should write Int16BE', () => {
        const buf = Buffer.alloc(2);
        buf.writeInt16BE(-2, 0);
        assert.strictEqual(buf[0], 0xff);
        assert.strictEqual(buf[1], 0xfe);
      });

      it('should write Int16LE', () => {
        const buf = Buffer.alloc(2);
        buf.writeInt16LE(-2, 0);
        assert.strictEqual(buf[0], 0xfe);
        assert.strictEqual(buf[1], 0xff);
      });
    });
  });

  describe('BigInt methods', () => {
    it('should read BigUInt64LE', () => {
      const buf = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      assert.strictEqual(buf.readBigUInt64LE(0), 1n);
    });

    it('should read BigUInt64BE', () => {
      const buf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
      assert.strictEqual(buf.readBigUInt64BE(0), 1n);
    });

    it('should write BigUInt64LE', () => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(1n, 0);
      assert.strictEqual(buf[0], 0x01);
      for (let i = 1; i < 8; i++) {
        assert.strictEqual(buf[i], 0x00);
      }
    });

    it('should write BigUInt64BE', () => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64BE(1n, 0);
      for (let i = 0; i < 7; i++) {
        assert.strictEqual(buf[i], 0x00);
      }
      assert.strictEqual(buf[7], 0x01);
    });

    it('should read BigInt64LE negative', () => {
      const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      assert.strictEqual(buf.readBigInt64LE(0), -1n);
    });

    it('should read BigInt64BE negative', () => {
      const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      assert.strictEqual(buf.readBigInt64BE(0), -1n);
    });
  });

  describe('Float methods', () => {
    it('should read/write FloatLE', () => {
      const buf = Buffer.alloc(4);
      buf.writeFloatLE(3.14, 0);
      const read = buf.readFloatLE(0);
      expect(read).toBeCloseTo(3.14, 5);
    });

    it('should read/write FloatBE', () => {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(3.14, 0);
      const read = buf.readFloatBE(0);
      expect(read).toBeCloseTo(3.14, 5);
    });

    it('should read/write DoubleLE', () => {
      const buf = Buffer.alloc(8);
      buf.writeDoubleLE(3.141592653589793, 0);
      const read = buf.readDoubleLE(0);
      expect(read).toBeCloseTo(3.141592653589793, 10);
    });

    it('should read/write DoubleBE', () => {
      const buf = Buffer.alloc(8);
      buf.writeDoubleBE(3.141592653589793, 0);
      const read = buf.readDoubleBE(0);
      expect(read).toBeCloseTo(3.141592653589793, 10);
    });
  });

  describe('encoding roundtrips', () => {
    const testCases = [
      'hello',
      'Hello, World!',
      '\u00bd + \u00bc = \u00be',
      'Unicode: \u4e2d\u6587',
    ];

    testCases.forEach((str) => {
      it(`should roundtrip UTF-8: ${str.substring(0, 20)}...`, () => {
        const buf = Buffer.from(str, 'utf8');
        assert.strictEqual(buf.toString('utf8'), str);
      });
    });

    it('should roundtrip hex', () => {
      const original = Buffer.from('hello world');
      const hex = original.toString('hex');
      const decoded = Buffer.from(hex, 'hex');
      assert.ok(bufferEquals(original, decoded));
    });

    it('should roundtrip base64', () => {
      const original = Buffer.from('hello world');
      const base64 = original.toString('base64');
      const decoded = Buffer.from(base64, 'base64');
      assert.ok(bufferEquals(original, decoded));
    });

    // SKIP: the `buffer` package (6.0.3) has no base64url encoding — Node added it in 15 and this is the version npm is tested against
    it.skip('should roundtrip base64url', () => {
      const original = Buffer.from('hello world');
      const base64url = original.toString('base64url');
      const decoded = Buffer.from(base64url, 'base64url');
      assert.ok(bufferEquals(original, decoded));
    });
  });
});
