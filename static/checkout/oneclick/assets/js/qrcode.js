/**
 * 轻量二维码生成器（QR Model 2 / Byte mode / EC level M）
 * 无外部依赖，输出 SVG。支持任意 UTF-8 内容（EIP-681 等）。
 *
 * 实现参考 ISO/IEC 18004，结构对齐 Nayuki 的 QR Code generator（MIT）。
 * 仅覆盖本项目需要的子集：版本 1-40 自动选择、Byte mode、纠错级别 M。
 */

const EC_LEVEL_M = { ordinal: 0, formatBits: 0, codewordsPerBlock: null };
const ECC_CODEWORDS_PER_BLOCK = {
  // [version][level] ; level 0 = M
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS = {
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

// 版本容量表（Byte mode, level M）：每版本可编码的字节数
const CAPACITY_BYTES_M = [
  -1, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331,
];

function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

/** GF(256) 乘法（多项式 0x11D） */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 生成 RS 纠错码字 */
function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

/** 计算总码字数 */
function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getNumDataCodewords(ver) {
  const ec = ECC_CODEWORDS_PER_BLOCK.M[ver];
  const blocks = NUM_ERROR_CORRECTION_BLOCKS.M[ver];
  return Math.floor(getNumRawDataModules(ver) / 8) - ec * blocks;
}

/** 选择最小可用版本 */
function chooseVersion(byteLen) {
  for (let v = 1; v <= 40; v++) {
    if (byteLen <= CAPACITY_BYTES_M[v]) return v;
  }
  throw new Error('data too long for QR code: ' + byteLen + ' bytes');
}

/** 数据码字 + 纠错码字交织 */
function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS.M[ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK.M[ver];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = reedSolomonDivisor(blockEccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = reedSolomonRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(Array.from(ecc)));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return result;
}

/** UTF-8 编码 */
function toUtf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
  return Array.from(Buffer.from(str, 'utf8'));
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    const alignPos = this.getAlignmentPatternPositions();
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  getAlignmentPatternPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  drawFormatBits(mask) {
    const data = (0 << 3) | mask; // level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const size = this.size;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
    this.setFunction(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  drawCodewords(data) {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const size = this.size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new Error('invalid mask');
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  getPenaltyScore() {
    const size = this.size;
    let score = 0;
    const m = this.modules;

    // 规则 1：连续同色
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
    }
    for (let x = 0; x < size; x++) {
      let run = 1;
      for (let y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
    }

    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }

    // 规则 3：类似 finder 的 1:1:3:1:1 模式
    const pat = [true, false, true, true, true, false, true];
    const check = (get) => {
      let s = 0;
      for (let i = 0; i + 7 <= size; i++) {
        let match = true;
        for (let j = 0; j < 7; j++) {
          if (get(i + j) !== pat[j]) { match = false; break; }
        }
        if (match) {
          const before = i >= 4 && [0, 1, 2, 3].every(k => !get(i - 1 - k));
          const after = i + 11 <= size && [7, 8, 9, 10].every(k => !get(i + k));
          if (before || after) s += 40;
        }
      }
      return s;
    };
    for (let y = 0; y < size; y++) score += check(x => m[y][x]);
    for (let x = 0; x < size; x++) score += check(y => m[y][x]);

    // 规则 4：暗模块比例
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;

    return score;
  }
}

/**
 * 生成二维码矩阵。
 * @param {string} text
 * @returns {{size:number, modules:boolean[][]}}
 */
export function encodeQr(text) {
  const bytes = toUtf8Bytes(text);
  const version = chooseVersion(bytes.length);
  const capacityBits = getNumDataCodewords(version) * 8;

  // 组装数据位流：mode(4) + count(8 或 16) + data
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); // Byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataCodewords.push(v);
  }
  for (let pad = 0xec; dataCodewords.length < getNumDataCodewords(version); pad ^= 0xec ^ 0x11) {
    dataCodewords.push(pad);
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version);

  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(allCodewords);

  // 选最优 mask
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask);
    matrix.drawFormatBits(mask);
    const score = matrix.getPenaltyScore();
    if (score < bestScore) { bestScore = score; bestMask = mask; }
    matrix.applyMask(mask); // 还原（mask 是异或）
  }
  matrix.applyMask(bestMask);
  matrix.drawFormatBits(bestMask);

  return { size: matrix.size, modules: matrix.modules };
}

/**
 * 渲染为 SVG 字符串。
 * @param {string} text
 * @param {{margin?:number, dark?:string, light?:string}} opts
 */
export function qrSvg(text, opts = {}) {
  const { size, modules } = encodeQr(text);
  const margin = opts.margin ?? 4;
  const dim = size + margin * 2;
  const dark = opts.dark || '#000000';
  const light = opts.light || '#ffffff';

  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += `M${x + margin},${y + margin}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="payment qr code">`
    + `<rect width="100%" height="100%" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/>`
    + `</svg>`;
}
