/**
 * JavaScript Inflate Library
 *
 * The MIT License
 *
 * Copyright (c) 2012 imaya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

goog.provide('Zlib.Inflate');

//-----------------------------------------------------------------------------

/** @define {boolean} export symbols. */
var ZLIB_INFLATE_EXPORT = false;

/** @define {number} buffer block size. */
var ZLIB_BUFFER_BLOCK_SIZE = 0x8000; // [ 0x8000 >= ZLIB_BUFFER_BLOCK_SIZE ]

//-----------------------------------------------------------------------------

goog.require('Zlib.Adler32');

goog.scope(function() {

/**
 * @param {!(Uint8Array|Array)} input deflated buffer.
 * @param {number=} opt_blocksize buffer blocksize.
 * @param {boolean=} opt_verify verify adler-32 checksum.
 * @constructor
 */
Zlib.Inflate = function(input, opt_blocksize, opt_verify) {
  /** @type {!(Array|Uint8Array)} inflated buffer */
  this.buffer;
  /** @type {!Array.<(Array|Uint8Array)>} */
  this.blocks = [];
  /** @type {number} block size. */
  this.blockSize = opt_blocksize ? opt_blocksize : ZLIB_BUFFER_BLOCK_SIZE;
  /** @type {(boolean|undefined)} verify flag. */
  this.verify = opt_verify;
  /** @type {!number} total output buffer pointer. */
  this.totalpos = 0;
  /** @type {!number} input buffer pointer. */
  this.ip = 0;
  /** @type {!number} bit stream reader buffer. */
  this.bitsbuf = 0;
  /** @type {!number} bit stream reader buffer size. */
  this.bitsbuflen = 0;
  /** @type {!(Array|Uint8Array)} input buffer. */
  this.input =
    (USE_TYPEDARRAY && input instanceof Array) ? new Uint8Array(input) : input;
  /** @type {!(Uint8Array|Array)} output buffer. */
  this.output;
  /** @type {!number} output buffer pointer. */
  this.op;
  /** @type {boolean} is final block flag. */
  this.bfinal = false;
  /** @type {Zlib.Inflate.Mode} inflate mode */
  this.mode = Zlib.Inflate.Mode.ADAPTIVE;
  /** @type {boolean} resize flag for memory size optimization. */
  this.resize = false;

  // initialize
  switch (this.mode) {
    case Zlib.Inflate.Mode.BLOCK:
      this.op = Zlib.Inflate.MaxBackwardLength;
      this.output =
        new (USE_TYPEDARRAY ? Uint8Array : Array)(
          Zlib.Inflate.MaxBackwardLength +
          this.blockSize +
          Zlib.Inflate.MaxCopyLength
        );
      break;
    case Zlib.Inflate.Mode.ADAPTIVE:
      this.op = 0;
      this.output = new (USE_TYPEDARRAY ? Uint8Array : Array)(this.blockSize);
      this.expandBuffer = this.expandBufferDynamic;
      this.concatBuffer = this.concatBufferDynamic;
      this.decodeHuffman = this.decodeHuffmanDynamic;
      break;
    default:
      throw new Error('invalid inflate mode');
  }

  // Compression Method and Flags
  var cmf = input[this.ip++];
  var flg = input[this.ip++];

  // compression method
  switch (cmf & 0x0f) {
    case Zlib.CompressionMethod.DEFLATE:
      this.method = Zlib.CompressionMethod.DEFLATE;
      break;
    default:
      throw new Error('unsupported compression method');
  }

  // fcheck
  if (((cmf << 8) + flg) % 31 !== 0) {
    throw new Error('invalid fcheck flag:' + ((cmf << 8) + flg) % 31);
  }

  // fdict (not supported)
  if (flg & 0x20) {
    throw new Error('fdict flag is not supported');
  }
}

/**
 * @enum {number}
 */
Zlib.Inflate.Mode = {
  BLOCK: 0,
  ADAPTIVE: 1
};

/**
 * inflate.
 * @return {!(Uint8Array|Array)} inflated buffer.
 */
Zlib.Inflate.prototype.inflate = function() {
  /** @type {!(Array|Uint8Array)} input buffer. */
  var input = this.input;
  /** @type {!(Uint8Array|Array)} inflated buffer. */
  var buffer;
  /** @type {number} adler-32 checksum */
  var adler32;

  while (!this.bfinal) {
    this.parseBlock();
  }

  buffer = this.concatBuffer();

  // verify adler-32
  if (this.verify) {
    adler32 =
      input[this.ip++] << 24 | input[this.ip++] << 16 |
      input[this.ip++] << 8 | input[this.ip++];

    if (adler32 !== Zlib.Adler32(buffer)) {
      throw new Error('invalid adler-32 checksum');
    }
  }

  return buffer;
};

/**
 * @const {number} max backward length for LZ77.
 */
Zlib.Inflate.MaxBackwardLength = 32768;

/**
 * @const {number} max copy length for LZ77.
 */
Zlib.Inflate.MaxCopyLength = 258;

/**
 * huffman order
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.Inflate.Order = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/**
 * huffman length code table.
 * @const {!(Array.<number>|Uint16Array)}
 */
Zlib.Inflate.LengthCodeTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([
  0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b,
  0x000d, 0x000f, 0x0011, 0x0013, 0x0017, 0x001b, 0x001f, 0x0023, 0x002b,
  0x0033, 0x003b, 0x0043, 0x0053, 0x0063, 0x0073, 0x0083, 0x00a3, 0x00c3,
  0x00e3, 0x0102, 0x0102, 0x0102
]);

/**
 * huffman length extra-bits table.
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.Inflate.LengthExtraTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint8Array(table) : table;
})([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0, 0, 0
]);

/**
 * huffman dist code table.
 * @const {!(Array.<number>|Uint16Array)}
 */
Zlib.Inflate.DistCodeTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([
  0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0007, 0x0009, 0x000d, 0x0011,
  0x0019, 0x0021, 0x0031, 0x0041, 0x0061, 0x0081, 0x00c1, 0x0101, 0x0181,
  0x0201, 0x0301, 0x0401, 0x0601, 0x0801, 0x0c01, 0x1001, 0x1801, 0x2001,
  0x3001, 0x4001, 0x6001
]);

/**
 * huffman dist extra-bits table.
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.Inflate.DistExtraTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint8Array(table) : table;
})([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13
]);

/**
 * fixed huffman length code table
 * @const {!Array}
 */
Zlib.Inflate.FixedLiteralLengthTable = (function(table) {
  return table;
})((function() {
  var lengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(288);
  var i, il;

  for (i = 0, il = lengths.length; i < il; ++i) {
    lengths[i] =
      (i <= 143) ? 8 :
      (i <= 255) ? 9 :
      (i <= 279) ? 7 :
      8;
  }

  return buildHuffmanTable(lengths);
})());

/**
 * fixed huffman distance code table
 * @const {!Array}
 */
Zlib.Inflate.FixedDistanceTable = (function(table) {
  return table;
})((function() {
  var lengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(30);
  var i, il;

  for (i = 0, il = lengths.length; i < il; ++i) {
    lengths[i] = 5;
  }

  return buildHuffmanTable(lengths);
})());

/**
 * parse deflated block.
 */
Zlib.Inflate.prototype.parseBlock = function() {
  /** @type {number} header */
  var hdr = this.readBits(3);

  // BFINAL
  if (hdr & 0x1) {
    this.bfinal = true;
  }

  // BTYPE
  hdr >>>= 1;
  switch (hdr) {
    // uncompressed
    case 0:
      this.parseUncompressedBlock();
      break;
    // fixed huffman
    case 1:
      this.parseFixedHuffmanBlock();
      break;
    // dynamic huffman
    case 2:
      this.parseDynamicHuffmanBlock();
      break;
    // reserved or other
    default:
      throw new Error('unknown BTYPE: ' + hdr);
  }
};

/**
 * read inflate bits
 * @param {number} length bits length.
 * @return {number} read bits.
 */
Zlib.Inflate.prototype.readBits = function(length) {
  var bitsbuf = this.bitsbuf;
  var bitsbuflen = this.bitsbuflen;
  var input = this.input;
  var ip = this.ip;

  /** @type {number} input and output byte. */
  var octet;

  // not enough buffer
  while (bitsbuflen < length) {
    // input byte
    octet = input[ip++];
    if (octet === void 0) {
      throw new Error('input buffer is broken');
    }

    // concat octet
    bitsbuf |= octet << bitsbuflen;
    bitsbuflen += 8;
  }

  // output byte
  octet = bitsbuf & /* MASK */ ((1 << length) - 1);
  bitsbuf >>>= length;
  bitsbuflen -= length;

  this.bitsbuf = bitsbuf;
  this.bitsbuflen = bitsbuflen;
  this.ip = ip;

  return octet;
};

/**
 * read huffman code using table
 * @param {Array} table huffman code table.
 * @return {number} huffman code.
 */
Zlib.Inflate.prototype.readCodeByTable = function(table) {
  var bitsbuf = this.bitsbuf;
  var bitsbuflen = this.bitsbuflen;
  var input = this.input;
  var ip = this.ip;

  /** @type {!(Array|Uint8Array)} huffman code table */
  var codeTable = table[0];
  /** @type {number} */
  var maxCodeLength = table[1];
  /** @type {number} input byte */
  var octet;
  /** @type {number} code */
  var code;
  /** @type {number} code length & code (16bit, 16bit) */
  var codeWithLength;
  /** @type {number} code bits length */
  var codeLength;

  // not enough buffer
  while (bitsbuflen < maxCodeLength) {
    octet = input[ip++];
    if (octet === void 0) {
      throw new Error('input buffer is broken');
    }
    bitsbuf |= octet << bitsbuflen;
    bitsbuflen += 8;
  }

  // read max length
  codeWithLength = codeTable[bitsbuf & ((1 << maxCodeLength) - 1)];
  codeLength = codeWithLength >>> 16;

  this.bitsbuf = bitsbuf >> codeLength;
  this.bitsbuflen = bitsbuflen - codeLength;
  this.ip = ip;

  return codeWithLength & 0xffff;
};

/**
 * parse uncompressed block.
 */
Zlib.Inflate.prototype.parseUncompressedBlock = function() {
  var input = this.input;
  var ip = this.ip;
  var output = this.output;
  var op = this.op;

  /** @type {number} input byte. */
  var octet;
  /** @type {number} block length */
  var len;
  /** @type {number} number for check block length */
  var nlen;
  /** @type {number} output buffer length */
  var olength = output.length;
  /** @type {number} copy counter */
  var preCopy;

  // skip buffered header bits
  this.bitsbuf = 0;
  this.bitsbuflen = 0;

  // len (1st)
  octet = input[ip++];
  if (octet === void 0) {
    throw new Error('invalid uncompressed block header: LEN (first byte)');
  }
  len = octet;

  // len (2nd)
  octet = input[ip++];
  if (octet === void 0) {
    throw new Error('invalid uncompressed block header: LEN (second byte)');
  }
  len |= octet << 8;

  // nlen (1st)
  octet = input[ip++];
  if (octet === void 0) {
    throw new Error('invalid uncompressed block header: NLEN (first byte)');
  }
  nlen = octet;

  // nlen (2nd)
  octet = input[ip++];
  if (octet === void 0) {
    throw new Error('invalid uncompressed block header: NLEN (second byte)');
  }
  nlen |= octet << 8;

  // check len & nlen
  if (len === ~nlen) {
    throw new Error('invalid uncompressed block header: length verify');
  }

  // check size
  if (ip + len > input.length) { throw new Error('input buffer is broken'); }

  // expand buffer
  switch (this.mode) {
    case Zlib.Inflate.Mode.BLOCK:
      // pre copy
      while (op + len >= output.length) {
        preCopy = olength - op;
        len -= preCopy;
        if (USE_TYPEDARRAY) {
          output.set(input.subarray(ip, ip + preCopy), op);
          op += preCopy;
          ip += preCopy;
        } else {
          while (preCopy--) {
            output[op++] = input[ip++];
          }
        }
        this.op = op;
        output = this.expandBuffer();
        op = this.op;
      }
      break;
    case Zlib.Inflate.Mode.ADAPTIVE:
      while (op + len > output.length) {
        output = this.expandBuffer({fixRatio: 2});
      }
      break;
    default:
      throw new Error('invalid inflate mode');
  }

  // copy
  if (USE_TYPEDARRAY) {
    output.set(input.subarray(ip, ip + len), op);
    op += len;
    ip += len;
  } else {
    while (len--) {
      output[op++] = input[ip++];
    }
  }

  this.ip = ip;
  this.op = op;
  this.output = output;
};

/**
 * parse fixed huffman block.
 */
Zlib.Inflate.prototype.parseFixedHuffmanBlock = function() {
  this.decodeHuffman(
    Zlib.Inflate.FixedLiteralLengthTable,
    Zlib.Inflate.FixedDistanceTable
  );
};

/**
 * parse dynamic huffman block.
 */
Zlib.Inflate.prototype.parseDynamicHuffmanBlock = function() {
  /** @type {number} number of literal and length codes. */
  var hlit = this.readBits(5) + 257;
  /** @type {number} number of distance codes. */
  var hdist = this.readBits(5) + 1;
  /** @type {number} number of code lengths. */
  var hclen = this.readBits(4) + 4;
  /** @type {!(Uint8Array|Array)} code lengths. */
  var codeLengths =
    new (USE_TYPEDARRAY ? Uint8Array : Array)(Zlib.Inflate.Order.length);
  /** @type {!Array} code lengths table. */
  var codeLengthsTable;
  /** @type {!(Uint32Array|Array)} literal and length code lengths. */
  var litlenLengths;
  /** @type {!(Uint32Array|Array)} distance code lengths. */
  var distLengths;
  /** @type {number} loop counter. */
  var i = 0;
  /** @type {number} loop counter. */
  var j = 0;

  // decode code lengths
  for (i = 0; i < hclen; ++i) {
    codeLengths[Zlib.Inflate.Order[i]] = this.readBits(3);
  }
  codeLengthsTable = buildHuffmanTable(codeLengths);

  // decode function
  function decode(num, table, lengths) {
    var code;
    var prev;
    var repeat;
    var i = 0;

    for (i = 0; i < num;) {
      code = this.readCodeByTable(table);
      switch (code) {
        case 16:
          repeat = 3 + this.readBits(2);
          while (repeat--) { lengths[i++] = prev; }
          break;
        case 17:
          repeat = 3 + this.readBits(3);
          while (repeat--) { lengths[i++] = 0; }
          prev = 0;
          break;
        case 18:
          repeat = 11 + this.readBits(7);
          while (repeat--) { lengths[i++] = 0; }
          prev = 0;
          break;
        default:
          lengths[i++] = code;
          prev = code;
          break;
      }
    }

    return lengths;
  }

  // literal and length code
  litlenLengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(hlit);

  // distance code
  distLengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(hdist);

  //return;
  this.decodeHuffman(
    buildHuffmanTable(decode.call(this, hlit, codeLengthsTable, litlenLengths)),
    buildHuffmanTable(decode.call(this, hdist, codeLengthsTable, distLengths))
  );
};

/**
 * decode huffman code
 * @param {!Array} litlen literal and length code table.
 * @param {!Array} dist distination code table.
 */
Zlib.Inflate.prototype.decodeHuffman = function(litlen, dist) {
  var output = this.output;
  var op = this.op;

  this.currentLitlenTable = litlen;
  this.currentDistTable = dist;

  /** @type {number} output position limit. */
  var olength = output.length - Zlib.Inflate.MaxCopyLength;
  /** @type {number} huffman code. */
  var code;
  /** @type {number} table index. */
  var ti;
  /** @type {number} huffman code distination. */
  var codeDist;
  /** @type {number} huffman code length. */
  var codeLength;
  /** @type {number} buffer position. */
  var bpos;
  /** @type {number} pre-copy counter. */
  var preCopy;

  while ((code = this.readCodeByTable(litlen)) !== 256) {
    // literal
    if (code < 256) {
      if (op >= olength) {
        this.op = op;
        output = this.expandBuffer();
        op = this.op;
      }
      output[op++] = code;

      continue;
    }

    // length code
    ti = code - 257;
    codeLength = Zlib.Inflate.LengthCodeTable[ti];
    if (Zlib.Inflate.LengthExtraTable[ti] > 0) {
      codeLength += this.readBits(Zlib.Inflate.LengthExtraTable[ti]);
    }

    // dist code
    code = this.readCodeByTable(dist);
    codeDist = Zlib.Inflate.DistCodeTable[code];
    if (Zlib.Inflate.DistExtraTable[code] > 0) {
      codeDist += this.readBits(Zlib.Inflate.DistExtraTable[code]);
    }

    // lz77 decode
    if (op >= olength) {
      this.op = op;
      output = this.expandBuffer();
      op = this.op;
    }
    while (codeLength--) {
      output[op] = output[(op++) - codeDist];
    }
  }

  this.op = op;
};

/**
 * decode huffman code (dynamic)
 * @param {!Array} litlen literal and length code table.
 * @param {!Array} dist distination code table.
 */
Zlib.Inflate.prototype.decodeHuffmanDynamic = function(litlen, dist) {
  var output = this.output;
  var op = this.op;

  this.currentLitlenTable = litlen;
  this.currentDistTable = dist;

  /** @type {number} output position limit. */
  var olength = output.length;
  /** @type {number} huffman code. */
  var code;
  /** @type {number} table index. */
  var ti;
  /** @type {number} huffman code distination. */
  var codeDist;
  /** @type {number} huffman code length. */
  var codeLength;
  /** @type {number} buffer position. */
  var bpos;
  /** @type {number} pre-copy counter. */
  var preCopy;

  while ((code = this.readCodeByTable(litlen)) !== 256) {
    // literal
    if (code < 256) {
      if (op === olength) {
        output = this.expandBuffer();
        olength = output.length;
      }
      output[op++] = code;

      continue;
    }

    // length code
    ti = code - 257;
    codeLength = Zlib.Inflate.LengthCodeTable[ti];
    if (Zlib.Inflate.LengthExtraTable[ti] > 0) {
      codeLength += this.readBits(Zlib.Inflate.LengthExtraTable[ti]);
    }

    // dist code
    code = this.readCodeByTable(dist);
    codeDist = Zlib.Inflate.DistCodeTable[code];
    if (Zlib.Inflate.DistExtraTable[code] > 0) {
      codeDist += this.readBits(Zlib.Inflate.DistExtraTable[code]);
    }

    // lz77 decode
    if (op + codeLength >= olength) {
      output = this.expandBuffer();
      olength = output.length;
    }
    while (codeLength--) {
      output[op] = output[(op++) - codeDist];
    }
  }

  this.op = op;
};

/**
 * expand output buffer.
 * @param {Object=} opt_param option parameters.
 * @return {!(Array|Uint8Array)} output buffer.
 */
Zlib.Inflate.prototype.expandBuffer = function(opt_param) {
  /** @type {!(Array|Uint8Array)} store buffer. */
  var buffer =
    new (USE_TYPEDARRAY ? Uint8Array : Array)(
        this.op - Zlib.Inflate.MaxBackwardLength
    );
  /** @type {number} backward base point */
  var backward = this.op - Zlib.Inflate.MaxBackwardLength;
  /** @type {number} copy index. */
  var i;
  /** @type {number} copy limit */
  var il;

  var output = this.output;

  // copy to output buffer
  if (USE_TYPEDARRAY) {
    buffer.set(output.subarray(Zlib.Inflate.MaxBackwardLength, buffer.length));
  } else {
    for (i = 0, il = buffer.length; i < il; ++i) {
      buffer[i] = output[i + Zlib.Inflate.MaxBackwardLength];
    }
  }

  this.blocks.push(buffer);
  this.totalpos += buffer.length;

  // copy to backward buffer
  if (USE_TYPEDARRAY) {
    output.set(
      output.subarray(backward, backward + Zlib.Inflate.MaxBackwardLength)
    );
  } else {
    for (i = 0; i < Zlib.Inflate.MaxBackwardLength; ++i) {
      output[i] = output[backward + i];
    }
  }

  this.op = Zlib.Inflate.MaxBackwardLength;

  return output;
};

/**
 * expand output buffer. (dynamic)
 * @param {Object=} opt_param option parameters.
 * @return {!(Array|Uint8Array)} output buffer pointer.
 */
Zlib.Inflate.prototype.expandBufferDynamic = function(opt_param) {
  /** @type {!(Array|Uint8Array)} store buffer. */
  var buffer;
  /** @type {number} expantion ratio. */
  var ratio = (this.input.length / this.ip + 1) | 0;
  /** @type {number} maximum number of huffman code. */
  var maxHuffCode;
  /** @type {number} new output buffer size. */
  var newSize;
  /** @type {number} max inflate size. */
  var maxInflateSize;

  if (opt_param) {
    if (typeof opt_param.fixRatio === 'number') {
      ratio = opt_param.fixRatio;
    }
    if (typeof opt_param.addRatio === 'number') {
      ratio += opt_param.addRatio;
    }
  }

  var input = this.input;
  var output = this.output;

  // calculate new buffer size
  if (ratio < 2) {
    maxHuffCode =
      (input.length - this.ip) / this.currentLitlenTable[2];
    maxInflateSize = (maxHuffCode / 2 * 258) | 0;
    newSize = maxInflateSize < output.length ?
      output.length + maxInflateSize :
      output.length << 1;
  } else {
    newSize = output.length * ratio;
  }

  // create new output buffer
  buffer = new (USE_TYPEDARRAY ? Uint8Array : Array)(newSize);

  // copy
  buffer.set(output);

  this.output = buffer;

  return this.output;
};

/**
 * concat output buffer.
 * @return {!(Array|Uint8Array)} output buffer.
 */
Zlib.Inflate.prototype.concatBuffer = function() {
  /** @type {number} buffer pointer. */
  var pos = 0;
  /** @type {number} buffer pointer. */
  var limit = this.totalpos + (this.op - Zlib.Inflate.MaxBackwardLength);
  /** @type {!(Array|Uint8Array)} output block array. */
  var output = this.output;
  /** @type {!Array} blocks array. */
  var blocks = this.blocks;
  /** @type {!(Array|Uint8Array)} output block array. */
  var block;
  /** @type {!(Array|Uint8Array)} output buffer. */
  var buffer = new (USE_TYPEDARRAY ? Uint8Array : Array)(limit);
  /** @type {number} loop counter. */
  var i;
  /** @type {number} loop limiter. */
  var il;
  /** @type {number} loop counter. */
  var j;
  /** @type {number} loop limiter. */
  var jl;

  // single buffer
  if (blocks.length === 0) {
    return USE_TYPEDARRAY ?
      this.output.subarray(Zlib.Inflate.MaxBackwardLength, this.op) :
      this.output.slice(Zlib.Inflate.MaxBackwardLength, this.op);
  }

  // copy to buffer
  for (i = 0, il = blocks.length; i < il; ++i) {
    block = blocks[i];
    for (j = 0, jl = block.length; j < jl; ++j) {
      buffer[pos++] = block[j];
    }
  }

  // current buffer
  for (i = Zlib.Inflate.MaxBackwardLength, il = this.op; i < il; ++i) {
    buffer[pos++] = output[i];
  }

  this.blocks = [];
  this.buffer = buffer;

  return this.buffer;
};

/**
 * concat output buffer. (dynamic)
 * @return {!(Array|Uint8Array)} output buffer.
 */
Zlib.Inflate.prototype.concatBufferDynamic = function() {
  /** @type {Array|Uint8Array} output buffer. */
  var buffer;
  var resize = this.resize;

  var op = this.op;

  if (resize) {
    if (USE_TYPEDARRAY) {
      buffer = new Uint8Array(op);
      buffer.set(this.output.subarray(0, op));
    } else {
      buffer = this.output.slice(0, op);
    }
  } else {
    buffer =
      USE_TYPEDARRAY ?  this.output.subarray(0, op) : this.output.slice(0, op);
  }


  this.buffer = buffer;

  return this.buffer;
};

//-----------------------------------------------------------------------------
// utility functions
//-----------------------------------------------------------------------------

/**
 * build huffman table from length list.
 * @param {!(Array.<number>|Uint8Array)} lengths length list.
 * @return {!Array} huffman table.
 */
function buildHuffmanTable(lengths) {
  /** @type {number} length list size. */
  var listSize = lengths.length;
  /** @type {number} max code length for table size. */
  var maxCodeLength = 0;
  /** @type {number} min code length for table size. */
  var minCodeLength = Number.POSITIVE_INFINITY;
  /** @type {number} table size. */
  var size;
  /** @type {!(Array|Uint8Array)} huffman code table. */
  var table;
  /** @type {number} bit length. */
  var bitLength;
  /** @type {number} huffman code. */
  var code;
  /**
   * サイズが 2^maxlength 個のテーブルを埋めるためのスキップ長.
   * @type {number} skip length for table filling.
   */
  var skip;
  /** @type {number} reversed code. */
  var reversed;
  /** @type {number} reverse temp. */
  var rtemp;
  /** @type {number} loop counter. */
  var i;
  /** @type {number} loop limit. */
  var il;
  /** @type {number} loop counter. */
  var j;
  /** @type {number} loop limit. */
  var jl;

  // Math.max は遅いので最長の値は for-loop で取得する
  for (i = 0, il = listSize; i < il; ++i) {
    if (lengths[i] > maxCodeLength) {
      maxCodeLength = lengths[i];
    }
    if (lengths[i] < minCodeLength) {
      minCodeLength = lengths[i];
    }
  }

  size = 1 << maxCodeLength;
  table = new (USE_TYPEDARRAY ? Uint32Array : Array)(size);

  // ビット長の短い順からハフマン符号を割り当てる
  for (bitLength = 1, code = 0, skip = 2; bitLength <= maxCodeLength;) {
    for (i = 0; i < listSize; ++i) {
      if (lengths[i] === bitLength) {
        // ビットオーダーが逆になるためビット長分並びを反転する
        for (reversed = 0, rtemp = code, j = 0; j < bitLength; ++j) {
          reversed = (reversed << 1) | (rtemp & 1);
          rtemp >>= 1;
        }

        // 最大ビット長をもとにテーブルを作るため、
        // 最大ビット長以外では 0 / 1 どちらでも良い箇所ができる
        // そのどちらでも良い場所は同じ値で埋めることで
        // 本来のビット長以上のビット数取得しても問題が起こらないようにする
        for (j = reversed; j < size; j += skip) {
          table[j] = (bitLength << 16) | i;
        }

        ++code;
      }
    }

    // 次のビット長へ
    ++bitLength;
    code <<= 1;
    skip <<= 1;
  }

  return [table, maxCodeLength, minCodeLength];
}

/**
 * byte string to array.
 * @param {!string} str byte string.
 * @return {!(Array|Uint8Array)} byte array.
 */
Zlib.Inflate.fromString = function(str) {
  /** @type {!(Array|Uint8Array)} converted array. */
  var array = new (USE_TYPEDARRAY ? Uint8Array : Array)(str.length);
  /** @type {number} loop counter. */
  var i = 0;
  /** @type {number} loop limiter. */
  var il = str.length;

  for (; i < il; ++i) {
    array[i] = str.charCodeAt(i);
  }

  return array;
};


//*****************************************************************************
// export
//*****************************************************************************
if (ZLIB_INFLATE_EXPORT) {
  goog.exportSymbol('Zlib.Inflate', Zlib.Inflate);
  goog.exportSymbol(
    'Zlib.Inflate.prototype.inflate',
    Zlib.Inflate.prototype.inflate
  );
}


// end of scope
});

/* vim:set expandtab ts=2 sw=2 tw=80: */
