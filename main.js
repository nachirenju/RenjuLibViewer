import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

import lz4 from 'lz4js';

const SIZE=15;
const MASK_TEXT=0x01, MASK_NOMOVE=0x02, MASK_START=0x04, MASK_COMMENT=0x08, MASK_TAG=0x10, MASK_NOCHILD=0x40, MASK_SIBLING=0x80;

// --- 安全装置: 最大読み込みノード数 (可変) ---
let currentMaxNodes = 3000000;

// --- Chunked Memory for Structure (Pure JS) ---
const CHUNK_BITS = 22; 
const CHUNK_SIZE = 1 << CHUNK_BITS; 
const CHUNK_MASK = CHUNK_SIZE - 1;

const POOL = {
    x: [], y: [], parent: [], child: [], sibling: [],
    hash: [], 
    hashNext: [] 
};

let globalNodeCount = 1;
// 読み込んだファイル形式を記憶する変数
let currentFileFormat = "lib"; 

function addChunk() {
    POOL.x.push(new Int8Array(CHUNK_SIZE).fill(-1));
    POOL.y.push(new Int8Array(CHUNK_SIZE).fill(-1));
    POOL.parent.push(new Int32Array(CHUNK_SIZE).fill(-1));
    POOL.child.push(new Int32Array(CHUNK_SIZE).fill(-1));
    POOL.sibling.push(new Int32Array(CHUNK_SIZE).fill(-1));
    POOL.hash.push(new BigUint64Array(CHUNK_SIZE));
    POOL.hashNext.push(new Int32Array(CHUNK_SIZE).fill(-1));
}

// 高速アクセサ (Pure JS)
const getX = (i) => POOL.x[i >> CHUNK_BITS][i & CHUNK_MASK];
const getY = (i) => POOL.y[i >> CHUNK_BITS][i & CHUNK_MASK];
const getParent = (i) => POOL.parent[i >> CHUNK_BITS][i & CHUNK_MASK];
const getChild = (i) => POOL.child[i >> CHUNK_BITS][i & CHUNK_MASK];
const getSibling = (i) => POOL.sibling[i >> CHUNK_BITS][i & CHUNK_MASK];
const getStoredHash = (i) => POOL.hash[i >> CHUNK_BITS][i & CHUNK_MASK];
const getHashNext = (i) => POOL.hashNext[i >> CHUNK_BITS][i & CHUNK_MASK];

const setX = (i, v) => POOL.x[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setY = (i, v) => POOL.y[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setParent = (i, v) => POOL.parent[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setChild = (i, v) => POOL.child[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setSibling = (i, v) => POOL.sibling[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setStoredHash = (i, v) => POOL.hash[i >> CHUNK_BITS][i & CHUNK_MASK] = v;
const setHashNext = (i, v) => POOL.hashNext[i >> CHUNK_BITS][i & CHUNK_MASK] = v;

// --- 自作ハッシュテーブル ---
const HASH_TABLE_BITS = 26;
const HASH_TABLE_SIZE = 1 << HASH_TABLE_BITS;
const HASH_TABLE_MASK = BigInt(HASH_TABLE_SIZE - 1);

let HASH_HEAD = new Int32Array(HASH_TABLE_SIZE).fill(-1);

function resetHashSystem() {
    HASH_HEAD.fill(-1);
}

function addNodeToHash(hash, nodeIdx) {
    const bucket = Number(hash & HASH_TABLE_MASK);
    setStoredHash(nodeIdx, hash);
    const oldHead = HASH_HEAD[bucket];
    setHashNext(nodeIdx, oldHead);
    HASH_HEAD[bucket] = nodeIdx;
}

function removeNodeFromHash(hash, nodeIdx) {
    const bucket = Number(hash & HASH_TABLE_MASK);
    let curr = HASH_HEAD[bucket];
    let prev = -1;
    while(curr !== -1) {
        if(curr === nodeIdx) {
            const next = getHashNext(curr);
            if(prev === -1) {
                HASH_HEAD[bucket] = next;
            } else {
                setHashNext(prev, next);
            }
            return;
        }
        prev = curr;
        curr = getHashNext(curr);
    }
}

function getNodesFromHash(hash) {
    const bucket = Number(hash & HASH_TABLE_MASK);
    let curr = HASH_HEAD[bucket];
    const result = [];
    while(curr !== -1) {
        if (getStoredHash(curr) === hash) {
            result.push(curr);
        }
        curr = getHashNext(curr);
    }
    return result;
}

function hasHashEntry(hash) {
    const bucket = Number(hash & HASH_TABLE_MASK);
    let curr = HASH_HEAD[bucket];
    while(curr !== -1) {
        if (getStoredHash(curr) === hash) return true;
        curr = getHashNext(curr);
    }
    return false;
}

// --- 文字列プール ---
const STR_POOL_SIZE = 64 * 1024 * 1024;
let STR_POOL = new Uint8Array(STR_POOL_SIZE);
let STR_CURSOR = 0;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const STR_TABLE_SIZE = 1 << 23;
const STR_TABLE_MASK = STR_TABLE_SIZE - 1;

const COMMENT_TABLE_KEY = new Int32Array(STR_TABLE_SIZE).fill(-1);
const COMMENT_TABLE_VAL = new Int32Array(STR_TABLE_SIZE).fill(-1);
const TEXT_TABLE_KEY = new Int32Array(STR_TABLE_SIZE).fill(-1);
const TEXT_TABLE_VAL = new Int32Array(STR_TABLE_SIZE).fill(-1);

function resetStringSystem() {
    STR_CURSOR = 0;
    COMMENT_TABLE_KEY.fill(-1);
    TEXT_TABLE_KEY.fill(-1);
}

function addString(nodeIdx, str, type) {
    const bytes = TEXT_ENCODER.encode(str);
    const len = bytes.length;
    if (len === 0) return;

    if (STR_CURSOR + len + 2 > STR_POOL.length) {
        // メモリ拡張
        const newPool = new Uint8Array(STR_POOL.length * 2);
        newPool.set(STR_POOL);
        STR_POOL = newPool;
    }

    const offset = STR_CURSOR;
    STR_POOL[offset] = len & 0xFF;
    STR_POOL[offset+1] = (len >> 8) & 0xFF;
    STR_POOL.set(bytes, offset + 2);
    STR_CURSOR += len + 2;

    const keys = type === 'comment' ? COMMENT_TABLE_KEY : TEXT_TABLE_KEY;
    const vals = type === 'comment' ? COMMENT_TABLE_VAL : TEXT_TABLE_VAL;
    
    let h = nodeIdx & STR_TABLE_MASK;
    while (keys[h] !== -1) {
        if (keys[h] === nodeIdx) break;
        h = (h + 1) & STR_TABLE_MASK;
    }
    keys[h] = nodeIdx;
    vals[h] = offset;
}

function getString(nodeIdx, type) {
    const keys = type === 'comment' ? COMMENT_TABLE_KEY : TEXT_TABLE_KEY;
    const vals = type === 'comment' ? COMMENT_TABLE_VAL : TEXT_TABLE_VAL;
    let h = nodeIdx & STR_TABLE_MASK;
    while (keys[h] !== -1) {
        if (keys[h] === nodeIdx) {
            const offset = vals[h];
            const len = STR_POOL[offset] | (STR_POOL[offset+1] << 8);
            return TEXT_DECODER.decode(STR_POOL.subarray(offset + 2, offset + 2 + len));
        }
        h = (h + 1) & STR_TABLE_MASK;
    }
    return null;
}
function hasString(nodeIdx, type) {
    const keys = type === 'comment' ? COMMENT_TABLE_KEY : TEXT_TABLE_KEY;
    let h = nodeIdx & STR_TABLE_MASK;
    while (keys[h] !== -1) {
        if (keys[h] === nodeIdx) return true;
        h = (h + 1) & STR_TABLE_MASK;
    }
    return false;
}

function initMemory() {
    POOL.x = []; POOL.y = []; POOL.parent = []; POOL.child = []; POOL.sibling = [];
    POOL.hash = []; POOL.hashNext = [];
    resetHashSystem();
    resetStringSystem();
    globalNodeCount = 1;
    addChunk();
}
initMemory();

function coordToRenlib(x,y){
  if(x<0||y<0) return "PASS";
  return String.fromCharCode("a".charCodeAt(0)+x) + (15-y);
}
function renlibToCoord(s) {
  if (s === "PASS") return { x: -1, y: -1 };
  return { x: s.charCodeAt(0) - 97, y: 15 - parseInt(s.slice(1)) };
}
function moveToSgf(move, size=15) {
  const col = move.charCodeAt(0) - 97, row = size - parseInt(move.slice(1));
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + row);
}
function convertMovesToSgfFromBoard(moves, size=15) {
  if (!moves || !moves.length) return "(;GM[1]SZ[15])";
  let s = "";
  moves.forEach((m, i) => s += `;${i%2?"W":"B"}[${moveToSgf(coordToRenlib(m.x, m.y), size)}]`);
  return `(;GM[1]SZ[${size}]\n${s})`;
}

const CX=7, CY=7;
const TRANSFORMS = [
  (x, y) => [x, y],
  (x, y) => [CX + (y - CY), CY - (x - CX)],
  (x, y) => [CX - (x - CX), CY - (y - CY)],
  (x, y) => [CX - (y - CY), CY + (x - CX)],
  (x, y) => [x, CY - (y - CY)],
  (x, y) => [CX + (y - CY), CY + (x - CX)],
  (x, y) => [CX - (x - CX), CY + (y - CY)],
  (x, y) => [CX - (y - CY), CY - (x - CX)]
];
const INV_INDEX = [0,3,2,1,4,5,6,7];
const Z_KEYS = new BigUint64Array(SIZE * SIZE * 3);
window.crypto.getRandomValues(Z_KEYS); 

class JSBoard {
  constructor(size = SIZE) {
    this.size = size;
    this.grid = new Int8Array(size * size);
    this.hist = [];
    this.player = 1;
    this.hashes = new BigUint64Array(8).fill(0n);
  }
  isInBoard(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }
  _updateHashes(x, y, p) {
    for(let t=0; t<8; t++) {
        const [tx, ty] = TRANSFORMS[t](x, y);
        const idx = (Math.round(ty) * this.size + Math.round(tx)) * 3 + p;
        this.hashes[t] ^= Z_KEYS[idx];
    }
  }
  move(x, y) {
    if (this.isInBoard(x, y)) {
        this.grid[y * this.size + x] = this.player;
        this._updateHashes(x, y, this.player);
    }
    this.hist.push({ x, y, player: this.player });
    this.player = 3 - this.player;
  }
  undo() {
    const h = this.hist.pop();
    if (!h) return;
    if (this.isInBoard(h.x, h.y)) {
        this.grid[h.y * this.size + h.x] = 0;
        this._updateHashes(h.x, h.y, h.player);
    }
    this.player = h.player;
  }
  getCanonicalData() {
    let minH = this.hashes[0];
    for(let i=1; i<8; i++) {
        if(this.hashes[i] < minH) minH = this.hashes[i];
    }
    return { hash: minH };
  }
  getGridVal(x, y) { return this.grid[y * this.size + x]; }
}

function getCanonicalGridFromNodeIdx(nodeIdx) {
    const g = new Int8Array(SIZE * SIZE);
    const path = [];
    let curr = nodeIdx;
    while(curr !== -1 && curr !== 0) {
          const px = getX(curr);
          const py = getY(curr);
          if(px >= 0) path.push({x: px, y: py});
          curr = getParent(curr);
    }
    let p = 1; 
    for(let i=path.length-1; i>=0; i--) {
        const m = path[i];
        if (m.x >= 0) g[m.y * SIZE + m.x] = p;
        p = 3 - p;
    }
    return g;
}

function getVisualToTargetTransforms(visualGridArr, targetGridArr) {
  const validIndices = [];
  for(let t=0; t<8; t++) {
    const T = TRANSFORMS[t];
    let match = true;
    outer: for(let y=0; y<SIZE; y++) {
      for(let x=0; x<SIZE; x++) {
        const [tx, ty] = T(x, y);
        if (visualGridArr[y*SIZE+x] !== targetGridArr[Math.round(ty)*SIZE+Math.round(tx)]) { match = false; break outer; }
      }
    }
    if(match) validIndices.push(t);
  }
  return validIndices;
}

// --- RenlibWriter (Pure JS - Iterative & Robust) ---
class RenlibWriter {
    constructor(encoding) {
        this.encoding = encoding || 'utf-8';
        this.buffer = new Uint8Array(1024 * 1024 * 10); // 10MB start
        this.pos = 0;
    }
    ensure(size) {
        if (this.pos + size >= this.buffer.length) {
            const newBuf = new Uint8Array(this.buffer.length * 2);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
    }
    write8(val) {
        this.ensure(1);
        this.buffer[this.pos++] = val & 0xFF;
    }
    writeString(str) {
        if (!str) return;
        const buffer = iconv.encode(str, this.encoding);
        const len = buffer.length;
        this.ensure(len + 2);
        this.buffer.set(buffer, this.pos);
        this.pos += len;
        this.buffer[this.pos++] = 0; 
        if ((len + 1) % 2 !== 0) {
            this.buffer[this.pos++] = 0;
        }
    }
    
    // ★このメソッドを追加！
    getBuffer() {
        return this.buffer.subarray(0, this.pos);
    }

    build() {
        // Header
        for(let i=0; i<20; i++) this.write8(0);
        
        const firstNode = getChild(0);
        if (firstNode === -1) return this; 

        const stack = [firstNode];
        
        while(stack.length > 0) {
            const nodeIdx = stack.pop();
            const x = getX(nodeIdx);
            const y = getY(nodeIdx);
            
            let moveByte = 0;
            if (x >= 0 && y >= 0) {
                moveByte = (x + 1) | (y << 4);
            }
            this.write8(moveByte);

            const child = getChild(nodeIdx);
            const sibling = getSibling(nodeIdx);
            const comment = getString(nodeIdx, 'comment');
            const text = getString(nodeIdx, 'text');

            let flags = 0;
            if (child === -1) flags |= MASK_NOCHILD;
            if (sibling !== -1) flags |= MASK_SIBLING;
            if (comment) flags |= MASK_COMMENT;
            if (text) flags |= MASK_TEXT;

            this.write8(flags);

            if (flags & MASK_TEXT) {
                this.write8(0);
                this.write8(0);
            }

            if (flags & MASK_COMMENT) this.writeString(comment);
            if (flags & MASK_TEXT) this.writeString(text);

            if (sibling !== -1) stack.push(sibling);
            if (child !== -1) stack.push(child);
        }
        return this;
    }
}
// --- YXDB Writer Class (Rapfi Compatible - Pure JS) ---
class YxdbWriter {
    constructor(encoding) {
        this.encoding = encoding || 'shift-jis'; 
        this.buffer = new Uint8Array(1024 * 1024 * 5); 
        this.pos = 0;
        this.recordCount = 0;
        this.textEncoder = new TextEncoder(); 
    }

    ensure(size) {
        if (this.pos + size >= this.buffer.length) {
            const newBuf = new Uint8Array(this.buffer.length * 2);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
    }

    write8(val) {
        this.ensure(1);
        this.buffer[this.pos++] = val & 0xFF;
    }

    write16(val) {
        this.ensure(2);
        this.buffer[this.pos++] = val & 0xFF;
        this.buffer[this.pos++] = (val >> 8) & 0xFF;
    }

    write32(val) {
        this.ensure(4);
        this.buffer[this.pos++] = val & 0xFF;
        this.buffer[this.pos++] = (val >> 8) & 0xFF;
        this.buffer[this.pos++] = (val >> 16) & 0xFF;
        this.buffer[this.pos++] = (val >> 24) & 0xFF;
    }

    writeBytes(bytes) {
        this.ensure(bytes.length);
        this.buffer.set(bytes, this.pos);
        this.pos += bytes.length;
    }

    writeMetadataRecord() {
        this.recordCount++;
        this.write16(3);
        this.write8(0); this.write8(0); this.write8(0);
        const metaStr = 'charset="UTF-8"';
        const metaBytes = this.textEncoder.encode(metaStr);
        const recordLen = 5 + metaBytes.length;
        this.write16(recordLen);
        this.write8(0); 
        this.write16(0); 
        this.write16(0); 
        this.writeBytes(metaBytes);
    }

    // ツリー書き込みもスタック化
    build() {
        this.write32(0); // Count placeholder
        this.writeMetadataRecord();
        
        const stack = [{ nodeIdx: 0, path: [] }];
        
        while (stack.length > 0) {
            const { nodeIdx, path } = stack.pop();
            
            const x = getX(nodeIdx);
            const y = getY(nodeIdx);
            
            const currentPath = [...path];
            if (x >= 0 && y >= 0) {
                currentPath.push({ x, y });
            }
            
            if (currentPath.length > 0) {
                this.writeRecord(nodeIdx, currentPath);
            }
            
            const child = getChild(nodeIdx);
            const sibling = getSibling(nodeIdx);
            
            // Push order: Sibling then Child
            if (sibling !== -1) {
                // Sibling shares the SAME path as parent (current node is not in path yet for sibling)
                // Wait, sibling is at same level.
                // Sibling path = Parent's path.
                // The 'path' variable passed here IS parent's path.
                stack.push({ nodeIdx: sibling, path: path });
            }
            
            if (child !== -1) {
                // Child extends current path
                stack.push({ nodeIdx: child, path: currentPath });
            }
        }
        
        const originalPos = this.pos;
        this.pos = 0;
        this.write32(this.recordCount);
        this.pos = originalPos;
        return this;
    }

    writeRecord(nodeIdx, path) {
        this.recordCount++;

        const blacks = [];
        const whites = [];
        path.forEach((m, i) => {
            if (i % 2 === 0) blacks.push(m);
            else whites.push(m);
        });

        // Sort keys (Pure JS)
        const sorter = (a, b) => (a.y * 15 + a.x) - (b.y * 15 + b.x); 
        blacks.sort(sorter);
        whites.sort(sorter);

        const numStones = blacks.length + whites.length;
        const numKeyBytes = 3 + (numStones * 2);

        this.write16(numKeyBytes);
        this.write8(1); // Rule
        this.write8(15); // W
        this.write8(15); // H

        blacks.forEach(m => { this.write8(m.x); this.write8(m.y); });
        whites.forEach(m => { this.write8(m.x); this.write8(m.y); });

        const comment = getString(nodeIdx, 'comment') || "";
        const text = getString(nodeIdx, 'text') || "";
        let outputString = "";
        
        if (text) outputString += `@BTXT@\n  ${text}\n\b`; 
        if (comment) outputString += comment;

        let encodedText = outputString ? iconv.encode(outputString, this.encoding) : new Uint8Array(0);

        const numRecordBytes = 1 + 2 + 2 + encodedText.length;
        this.write16(numRecordBytes);
        this.write8(0); 
        this.write16(0); 
        this.write16(0); 
        this.writeBytes(encodedText);
    }
    
    getBuffer() {
        return this.buffer.subarray(0, this.pos);
    }
}

// --- RenlibReaderJS (Pure JS Version) ---
class RenlibReaderJS {
  constructor(buffer, encoding = "shift-jis") {
    this.data = new DataView(buffer);
    this.bufferRaw = buffer; 
    this.pos = 0;
    this.decoder = new TextDecoder(encoding); 
  }
  _get8() { 
    if(this.pos >= this.data.byteLength) throw new Error("EOF");
    return this.data.getUint8(this.pos++); 
  }
  readHeader() { this.pos += 20; return ""; }
  _readString() {
    const start = this.pos;
    let len = 0;
    while (start + len < this.data.byteLength) {
      if (this.data.getUint8(start + len) === 0) break;
      len++;
    }
    const bytes = new Uint8Array(this.bufferRaw, this.data.byteOffset + start, len);
    const str = this.decoder.decode(bytes);
    const consumed = len + 1;
    this.pos += consumed;
    if (consumed % 2 !== 0) { this.pos++; }
    return str;
  }
  readNodeToPool() {
    if (globalNodeCount >= currentMaxNodes) {
         throw new Error("NODE_LIMIT_REACHED");
    }

    if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
    const move = this._get8();
    const flag = this._get8();
    let x = -1, y = -1;
    if (move !== 0x00) {
        x = (move & 0x0f) - 1;
        y = (move >> 4);
    }
    const idx = globalNodeCount++;
    setX(idx, x); setY(idx, y);
    if ((flag & MASK_TEXT)) { this.pos += 2; } 
    if ((flag & MASK_COMMENT)) {
        const s = this._readString();
        if(s) addString(idx, s, 'comment');
    }
    if ((flag & MASK_TEXT)) {
        const s = this._readString();
        if(s) addString(idx, s, 'text');
    }
    return {
        idx: idx,
        hasChild: (flag & MASK_NOCHILD) === 0,
        hasSibling: (flag & MASK_SIBLING) !== 0
    };
  }
  async traverse() {
    resetHashSystem();
    resetStringSystem();
    initMemory(); 
    this.readHeader();
    let rootInfo = this.readNodeToPool();
    if (getX(rootInfo.idx) < 0 && rootInfo.hasChild) {
        globalNodeCount--; 
        rootInfo = this.readNodeToPool();
    }
    setX(0, -1); setY(0, -1);
    setChild(0, rootInfo.idx);
    setParent(rootInfo.idx, 0);

    const STACK_SIZE = 20000;
    const stackNode = new Int32Array(STACK_SIZE);
    const stackStage = new Uint8Array(STACK_SIZE);
    const stackFlags = new Uint8Array(STACK_SIZE);
    let sp = 0; 
    stackNode[0] = rootInfo.idx;
    stackStage[0] = 0; 
    stackFlags[0] = (rootInfo.hasChild ? 1 : 0) | (rootInfo.hasSibling ? 2 : 0);
    const board = new JSBoard(SIZE);

    const statusEl = document.getElementById("loadingStatus");
    let iterCount = 0;

    try {
        while (sp >= 0) {
            if (++iterCount % 5000 === 0) {
                if(statusEl) statusEl.textContent = `Loading... ${globalNodeCount.toLocaleString()} nodes`;
                await new Promise(r => setTimeout(r, 0)); 
            }
            const currIdx = stackNode[sp];
            const stage = stackStage[sp];
            const flags = stackFlags[sp];
            const hasChild = (flags & 1) !== 0;
            const hasSibling = (flags & 2) !== 0;

            if (stage === 0) {
                const px = getX(currIdx);
                const py = getY(currIdx);
                const isValid = (px < 0) || board.isInBoard(px, py);
                if (isValid) {
                    board.move(px, py);
                    const { hash } = board.getCanonicalData();
                    addNodeToHash(hash, currIdx);
                }
                stackStage[sp] = 1; 
                if (hasChild) {
                    try {
                        const childInfo = this.readNodeToPool();
                        setParent(childInfo.idx, currIdx);
                        setChild(currIdx, childInfo.idx);
                        sp++;
                        if(sp >= STACK_SIZE) throw new Error("Stack Overflow");
                        stackNode[sp] = childInfo.idx;
                        stackStage[sp] = 0;
                        stackFlags[sp] = (childInfo.hasChild ? 1 : 0) | (childInfo.hasSibling ? 2 : 0);
                        continue; 
                    } catch(e) { 
                        if(e.message === "NODE_LIMIT_REACHED") throw e;
                        if(e.message!=="EOF") throw e; 
                    }
                }
            }
            if (stage === 1) {
                const px = getX(currIdx);
                const py = getY(currIdx);
                if ((px < 0) || board.isInBoard(px, py)) board.undo();
                sp--; 
                if (hasSibling) {
                    try {
                        const sibInfo = this.readNodeToPool();
                        const pIdx = getParent(currIdx);
                        setParent(sibInfo.idx, pIdx);
                        setSibling(currIdx, sibInfo.idx);
                        sp++;
                        stackNode[sp] = sibInfo.idx;
                        stackStage[sp] = 0;
                        stackFlags[sp] = (sibInfo.hasChild ? 1 : 0) | (sibInfo.hasSibling ? 2 : 0);
                    } catch(e) { 
                        if(e.message === "NODE_LIMIT_REACHED") throw e;
                        if(e.message!=="EOF") throw e; 
                    }
                }
            }
        }
    } catch(err) {
        const isMemoryError = err.message === "NODE_LIMIT_REACHED" 
                           || err.name === "RangeError" 
                           || (err.message && err.message.includes("memory"));

        if (isMemoryError) {
            alert(`読み込みを中断しました（上限到達またはメモリ不足）。\n読み込めた部分のみを表示します。\n${err.message}`);
        } else {
            throw err;
        }
    }
  }
}

// --- YXDB Reader Class (Pure JS - Tree Builder Version) ---
class YxdbReaderJS {
    constructor(buffer, encoding) {
        this.bufferRaw = buffer;
        this.encoding = encoding || 'utf-8';
    }

    _get32() {
        if (this.pos + 4 > this.data.byteLength) throw new Error("EOF");
        const v = this.data.getUint32(this.pos, true); 
        this.pos += 4;
        return v;
    }
    
    _get16() {
        if (this.pos + 2 > this.data.byteLength) throw new Error("EOF");
        const v = this.data.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    _readBytes(len) {
        if (this.pos + len > this.data.byteLength) throw new Error("EOF");
        const arr = new Uint8Array(this.bufferRaw, this.pos, len);
        this.pos += len;
        return arr;
    }

    // ★純粋JSでツリーを復元する関数
    _getOrCreateChild(parentIdx, x, y) {
        let child = getChild(parentIdx);
        
        while (child !== -1) {
            if (getX(child) === x && getY(child) === y) {
                return child;
            }
            child = getSibling(child);
        }

        if (globalNodeCount >= currentMaxNodes) {
            throw new Error("NODE_LIMIT_REACHED");
        }
        if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
        const newNode = globalNodeCount++;
        setX(newNode, x);
        setY(newNode, y);
        setParent(newNode, parentIdx);
        
        const oldHead = getChild(parentIdx);
        setChild(parentIdx, newNode);
        setSibling(newNode, oldHead);
        
        return newNode;
    }

    async traverse() {
        resetHashSystem();
        resetStringSystem();
        initMemory(); 

        let uint8Buf = new Uint8Array(this.bufferRaw);

        if (uint8Buf.length >= 4) {
             const view = new DataView(uint8Buf.buffer, uint8Buf.byteOffset, uint8Buf.byteLength);
             if (view.getUint32(0, true) === 0x184D2204) {
                 try {
                     uint8Buf = lz4.decompress(uint8Buf);
                 } catch(e) {
                     console.error(e);
                     throw new Error("LZ4 Decompression failed.");
                 }
             }
        }

        this.data = new DataView(uint8Buf.buffer, uint8Buf.byteOffset, uint8Buf.byteLength);
        this.bufferRaw = uint8Buf.buffer; 
        this.pos = 0;

        const numRecords = this._get32();
        
        if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
        const rootIdx = globalNodeCount++;
        setX(rootIdx, -1); setY(rootIdx, -1);
        
        const statusEl = document.getElementById("loadingStatus");
        let iterCount = 0;

        try {
            for (let i = 0; i < numRecords; i++) {
                if (++iterCount % 2000 === 0) {
                    if(statusEl) statusEl.textContent = `Loading DB... ${i}/${numRecords}`;
                    await new Promise(r => setTimeout(r, 0));
                    if (globalNodeCount >= currentMaxNodes) throw new Error("NODE_LIMIT_REACHED");
                }

                const numKeyBytes = this._get16();
                if (numKeyBytes === 0) continue; 
                
                const keyData = this._readBytes(numKeyBytes);
                
                const numStones = Math.floor((numKeyBytes - 3) / 2);
                const moves = [];

                if (numStones >= 0) {
                    const numBlack = Math.ceil(numStones / 2);
                    const numWhite = Math.floor(numStones / 2);

                    for(let k=0; k<numBlack; k++) {
                        let bx = keyData[3 + k*2];
                        let by = keyData[4 + k*2];
                        if (bx === 255) bx = -1;
                        if (by === 255) by = -1;
                        if(bx !== undefined && bx !== -1) moves.push({x: bx, y: by, color: 1});
                    }
                    for(let k=0; k<numWhite; k++) {
                        let wx = keyData[3 + numBlack*2 + k*2];
                        let wy = keyData[4 + numBlack*2 + k*2]; 
                        if (wx === 255) wx = -1;
                        if (wy === 255) wy = -1;
                        if(wx !== undefined && wx !== -1) moves.push({x: wx, y: wy, color: 2});
                    }
                    
                    const orderedMoves = [];
                    for(let k=0; k<numStones; k++) {
                        if (k % 2 === 0) orderedMoves.push(moves[k/2]);
                        else orderedMoves.push(moves[numBlack + Math.floor(k/2)]);
                    }

                    const board = new JSBoard(SIZE); 
                    let currNodeIdx = rootIdx;

                    for (const move of orderedMoves) {
                        if(move && move.x !== -1 && move.y !== -1) {
                            board.move(move.x, move.y); 
                            // ★修正済み: Pure JS版の _getOrCreateChild を使用
                            currNodeIdx = this._getOrCreateChild(currNodeIdx, move.x, move.y);
                        }
                    }

                    const { hash } = board.getCanonicalData();
                    setStoredHash(currNodeIdx, hash);
                    addNodeToHash(hash, currNodeIdx);

                    const numRecordBytes = this._get16();
                    const recordData = this._readBytes(numRecordBytes);
                    
                    let calcText = "";
                    let userLabel = ""; 
                    let comment = "";

                    if (numRecordBytes >= 5) {
                        const label = recordData[0];
                        const value = new DataView(recordData.buffer, recordData.byteOffset, recordData.byteLength).getInt16(1, true);
                        
                        const VALUE_MATE = 30000;
                        const VALUE_MATE_THRESHOLD = 29500; 
                        const absVal = Math.abs(value);

                        if (absVal > VALUE_MATE_THRESHOLD) {
                            const steps = VALUE_MATE - absVal + 1;
                            calcText = value < 0 ? `W${steps}` : `L${steps}`;
                        }
                        else if (label === 1) calcText = "W";
                        else if (label === 2) calcText = "L";
                        else if (value !== 0) {
                            const K = 250; 
                            const winRate = 1 / (1 + Math.exp(value / K));
                            const winPercent = Math.floor(winRate * 100);
                            if (winPercent === 100) calcText = "W";
                            else if (winPercent === 0) calcText = "L";
                            else calcText = winPercent.toString(); 
                        }

                        const textData = recordData.subarray(5);
                        const decoder = new TextDecoder('utf-8');
                        const fullText = decoder.decode(textData);
                        
                        if (fullText.startsWith("@BTXT@")) {
                            const bIndex = fullText.indexOf('\b');
                            const endOfBtxt = (bIndex !== -1) ? bIndex : fullText.length;
                            const btxtBody = fullText.substring(6, endOfBtxt); 
                            const lines = btxtBody.split('\n');
                            for (let line of lines) {
                                if (line.length > 2) {
                                    userLabel = line.substring(2); 
                                    break; 
                                }
                            }
                            if (bIndex !== -1) comment = fullText.substring(bIndex + 1);
                        } else {
                            comment = fullText;
                        }
                        if (comment.includes("charset=")) comment = "";
                    }

                    let finalBoardText = userLabel || calcText;
                    if (comment) addString(currNodeIdx, comment, 'comment');
                    if (finalBoardText) addString(currNodeIdx, finalBoardText, 'text');

                } else {
                    const numRecordBytes = this._get16();
                    this.pos += numRecordBytes;
                }
            }
        } catch (err) {
            if (err.message === "NODE_LIMIT_REACHED" || err.message.includes("Invalid array length")) {
                alert(`読み込みを中断しました（${globalNodeCount.toLocaleString()}ノード）。\n上限に達しました。SettingsからMax Nodesを増やしてください。`);
            } else {
                throw err;
            }
        }
        
        if(statusEl) statusEl.textContent = `DB Load Complete: ${numRecords} records.`;
        await new Promise(r => setTimeout(r, 500));
    }
}

let currentNodeIdx = 0;
let moves = []; 
let redoStack = []; 
let mainBoard = new JSBoard(SIZE);
let isPuzzleMode = false;
let savedPuzzleState = null; 

const specialClickMap = new Map(); 
const canvas=document.getElementById("board"), ctx=canvas.getContext("2d");
const elMoves = document.getElementById("movesText"), elSgf = document.getElementById("sgfText"), elComment = document.getElementById("comment-text"); 
let isTextMode = false;

resetHashSystem();
const emptyBoard = new JSBoard(SIZE);
addNodeToHash(emptyBoard.getCanonicalData().hash, 0);

const btnPuzzle = document.getElementById("btnPuzzle");
btnPuzzle.addEventListener("click", togglePuzzleMode);

function togglePuzzleMode() {
    isPuzzleMode = !isPuzzleMode;
    if (isPuzzleMode) {
        btnPuzzle.classList.add("btn-active");
        savedPuzzleState = {
            moves: [...moves],
            nodeIdx: currentNodeIdx,
            gridSnapshot: new Int8Array(mainBoard.grid) 
        };
        moves = [];
    } else {
        btnPuzzle.classList.remove("btn-active");
        if (savedPuzzleState) {
            moves = savedPuzzleState.moves;
            currentNodeIdx = savedPuzzleState.nodeIdx;
            mainBoard = new JSBoard(SIZE);
            moves.forEach(m => mainBoard.move(m.x, m.y));
            savedPuzzleState = null;
        }
    }
    renderBoard();
}

function undoMoves(steps) {
  let changed = false;
  for (let i = 0; i < steps; i++) {
    if (!moves.length) break;
    if (isPuzzleMode && moves.length === 0) break; 
    const m = moves.pop(); 
    redoStack.push(m); 
    mainBoard.undo(); 
    changed = true;
    if (!isPuzzleMode) {
        const pIdx = getParent(currentNodeIdx);
        if (currentNodeIdx !== 0 && pIdx !== -1) {
          currentNodeIdx = pIdx;
        } else {
          const { hash } = mainBoard.getCanonicalData();
          const nodes = getNodesFromHash(hash);
          currentNodeIdx = (nodes && nodes.length > 0) ? nodes[0] : 0;
        }
    }
  }
  if (changed) renderBoard();
}

function redoMoves(steps) {
  let changed = false;
  for (let i = 0; i < steps; i++) {
    if (!redoStack.length) break;
    const m = redoStack.pop(); 
    moves.push(m);
    mainBoard.move(m.x, m.y);
    if (!isPuzzleMode) {
        let childIdx = getChild(currentNodeIdx);
        let nextNode = -1;
        while(childIdx !== -1) {
            if (getX(childIdx) === m.x && getY(childIdx) === m.y) {
                nextNode = childIdx;
                break;
            }
            childIdx = getSibling(childIdx);
        }
        if (nextNode === -1) {
           const { hash } = mainBoard.getCanonicalData();
           const nodes = getNodesFromHash(hash);
           if (nodes && nodes.length) nextNode = nodes[0];
        }
        if (nextNode === -1) {
           if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
           nextNode = globalNodeCount++;
           setX(nextNode, m.x); setY(nextNode, m.y);
           setParent(nextNode, currentNodeIdx);
           const oldHead = getChild(currentNodeIdx);
           setChild(currentNodeIdx, nextNode);
           setSibling(nextNode, oldHead);
           const { hash } = mainBoard.getCanonicalData();
           addNodeToHash(hash, nextNode);
        }
        currentNodeIdx = nextNode;
    }
    changed = true;
  }
  if (changed) renderBoard();
}

document.getElementById("btnUndo1").addEventListener("click", () => undoMoves(1));
document.getElementById("btnUndo5").addEventListener("click", () => undoMoves(5));
document.getElementById("btnRedo1").addEventListener("click", () => redoMoves(1));
document.getElementById("btnRedo5").addEventListener("click", () => redoMoves(5));
const btnText = document.getElementById("btnText");
btnText.addEventListener("click", () => { isTextMode = !isTextMode; btnText.classList.toggle("btn-active", isTextMode); });

function deleteSubtree(nodeIdx) {
    if (nodeIdx === -1) return;
    let child = getChild(nodeIdx);
    while (child !== -1) {
        let nextChild = getSibling(child); 
        deleteSubtree(child);
        child = nextChild;
    }
    const hash = getStoredHash(nodeIdx);
    if (hash !== 0n) removeNodeFromHash(hash, nodeIdx);
}

document.getElementById("btnDelete").addEventListener("click", () => {
    if (isPuzzleMode) {
        undoMoves(1);
        return;
    }
    if (currentNodeIdx === 0) return;
    if (!confirm("現在の局面以降のすべての分岐を削除しますか？\nDelete this move and all sub-branches?")) return;
    const pIdx = getParent(currentNodeIdx);
    if (pIdx === -1) return;
    deleteSubtree(currentNodeIdx);
    let child = getChild(pIdx);
    let prev = -1;
    let found = false;
    while (child !== -1) {
        if (child === currentNodeIdx) {
            const nextSib = getSibling(currentNodeIdx);
            if (prev === -1) {
                setChild(pIdx, nextSib);
            } else {
                setSibling(prev, nextSib);
            }
            found = true;
            break;
        }
        prev = child;
        child = getSibling(child);
    }
    if (found) undoMoves(1);
});

document.getElementById("btnNew").addEventListener("click", () => {
    if (!confirm("新しい盤面を作成しますか？\nCreate a new board?")) return;
    initMemory(); 
    currentNodeIdx = 0;
    moves = [];
    redoStack = [];
    mainBoard = new JSBoard(SIZE);
    specialClickMap.clear();
    isPuzzleMode = false;
    savedPuzzleState = null;
    btnPuzzle.classList.remove("btn-active");
    document.getElementById("loadLib").value = ""; 
    const emptyHash = mainBoard.getCanonicalData().hash;
    addNodeToHash(emptyHash, 0);
    renderBoard();
});

// --- UI Elements & Load Logic ---
let pendingFile = null;
const encodingModal = document.getElementById("encodingModal");
const btnConfirmEncoding = document.getElementById("btnConfirmEncoding");
const modalEncodingSelect = document.getElementById("modalEncodingSelect");
const loadingOverlay = document.getElementById("loadingOverlay");

document.getElementById("loadLib").addEventListener("change", e => {
  if(isPuzzleMode) togglePuzzleMode();
  const file = e.target.files[0];
  if (!file) return;
  
  pendingFile = file;
  encodingModal.classList.remove("hidden");
  
  e.target.value = '';
});

btnConfirmEncoding.addEventListener("click", () => {
    if (!pendingFile) {
        encodingModal.classList.add("hidden");
        return;
    }
    const encoding = modalEncodingSelect.value;
    encodingModal.classList.add("hidden");
    
    loadingOverlay.classList.remove("hidden");
    
    if (pendingFile.name.toLowerCase().endsWith(".db")) {
        currentFileFormat = "db";
    } else {
        currentFileFormat = "lib";
    }

    setTimeout(async () => {
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                if (currentFileFormat === "db") {
                    const dbReader = new YxdbReaderJS(reader.result, encoding);
                    await dbReader.traverse();
                } else {
                    const rr = new RenlibReaderJS(reader.result, encoding);
                    await rr.traverse(); 
                }
                
                currentNodeIdx = 0; 
                moves = []; 
                redoStack = []; 
                mainBoard = new JSBoard(SIZE);
                const emptyHash = mainBoard.getCanonicalData().hash;
                addNodeToHash(emptyHash, 0);
                renderBoard();
            } catch (err) { 
                if (err.message !== "EOF" && err.message !== "NODE_LIMIT_REACHED") {
                    alert(`Error: ${err.message}`); 
                }
                if (err.message === "NODE_LIMIT_REACHED") {
                    currentNodeIdx = 0; 
                    moves = []; 
                    redoStack = []; 
                    mainBoard = new JSBoard(SIZE);
                    const emptyHash = mainBoard.getCanonicalData().hash;
                    addNodeToHash(emptyHash, 0);
                    renderBoard();
                }
            } finally {
                loadingOverlay.classList.add("hidden");
                pendingFile = null;
            }
        };
        reader.readAsArrayBuffer(pendingFile);
    }, 50);
});

elComment.addEventListener('input', (e) => { 
    if (currentNodeIdx !== 0) addString(currentNodeIdx, e.target.value, 'comment');
});

function handleInput(text, isSgf) {
  if(isPuzzleMode) togglePuzzleMode(); 
  moves = []; redoStack = [];
  mainBoard = new JSBoard(SIZE); currentNodeIdx = 0;
  const regex = isSgf ? /;[BW]\[([a-o]{2})\]/gi : /[a-o](?:1[0-5]|[1-9])/gi;
  const matches = [...text.matchAll(regex)];
  for (const m of matches) {
    let x, y;
    if(isSgf) {
       const c = m[1].toLowerCase();
       x = c.charCodeAt(0)-97; y = c.charCodeAt(1)-97;
    } else {
       const c = renlibToCoord(m[0].toLowerCase());
       x=c.x; y=c.y;
    }
    if (!mainBoard.isInBoard(x, y) || mainBoard.getGridVal(x, y) !== 0) break;
    moves.push({x, y});
    mainBoard.move(x, y);
    let childIdx = getChild(currentNodeIdx);
    let nextNode = -1;
    while(childIdx !== -1) {
        if (getX(childIdx) === x && getY(childIdx) === y) {
            nextNode = childIdx;
            break;
        }
        childIdx = getSibling(childIdx);
    }
    if (nextNode === -1) {
       const { hash } = mainBoard.getCanonicalData();
       const nodes = getNodesFromHash(hash);
       if (nodes && nodes.length) nextNode = nodes[0];
    }
    if (nextNode === -1) {
       if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
       nextNode = globalNodeCount++;
       setX(nextNode, x); setY(nextNode, y);
       setParent(nextNode, currentNodeIdx);
       const oldHead = getChild(currentNodeIdx);
       setChild(currentNodeIdx, nextNode);
       setSibling(nextNode, oldHead);
       const { hash } = mainBoard.getCanonicalData();
       addNodeToHash(hash, nextNode);
    }
    currentNodeIdx = nextNode;
  }
  renderBoard();
}
elMoves.addEventListener('input', e => handleInput(e.target.value, false));
elSgf.addEventListener('input', e => handleInput(e.target.value, true));

function copyToClipboard(id) {
  const el = document.getElementById(id); el.select(); el.setSelectionRange(0, 99999);
  const toast = document.getElementById("toast");
  const show = () => { toast.className = "show"; setTimeout(() => toast.className = "", 2000); };
  navigator.clipboard.writeText(el.value).then(show, () => { document.execCommand("copy"); show(); });
}
document.getElementById("btnCopyMoves").addEventListener("click", () => copyToClipboard("movesText"));
document.getElementById("btnCopySgf").addEventListener("click", () => copyToClipboard("sgfText"));

canvas.addEventListener("click", e => {
  const rect = canvas.getBoundingClientRect(), scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
  const gx = Math.round(((e.clientX - rect.left) * scaleX - 50) / 50), gy = Math.round(((e.clientY - rect.top) * scaleY - 50) / 50);
  if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) return;
  if (isTextMode) {
     if (mainBoard.getGridVal(gx, gy) !== 0) return; 
     const key = `${gx},${gy}`;
     let targetIdx = specialClickMap.has(key) ? specialClickMap.get(key).idx : -1;
     if (targetIdx === -1) {
        if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
        targetIdx = globalNodeCount++;
        setX(targetIdx, gx); setY(targetIdx, gy);
        setParent(targetIdx, currentNodeIdx);
        const oldHead = getChild(currentNodeIdx);
        setChild(currentNodeIdx, targetIdx);
        setSibling(targetIdx, oldHead);
     }
     const currentTxt = getString(targetIdx, 'text') || "";
     const input = prompt("Text:", currentTxt);
     if (input !== null) { addString(targetIdx, input, 'text'); renderBoard(); }
     return; 
  }
  if (mainBoard.getGridVal(gx, gy) !== 0) return;
  const key = `${gx},${gy}`;
  moves.push({ x: gx, y: gy }); mainBoard.move(gx, gy);
  redoStack = []; 
  if (specialClickMap.has(key) && !isPuzzleMode) {
    const data = specialClickMap.get(key);
    if (data.idx !== -1 && data.idx !== null) currentNodeIdx = data.idx;
    else {
       const { hash } = mainBoard.getCanonicalData();
       const nodes = getNodesFromHash(hash);
       currentNodeIdx = (nodes && nodes.length) ? nodes[0] : -1;
    }
  } else {
    if(!isPuzzleMode) {
        if ((globalNodeCount & CHUNK_MASK) === 0) addChunk();
        const newNode = globalNodeCount++;
        setX(newNode, gx); setY(newNode, gy);
        setParent(newNode, currentNodeIdx);
        const oldHead = getChild(currentNodeIdx);
        setChild(currentNodeIdx, newNode);
        setSibling(newNode, oldHead);
        const { hash } = mainBoard.getCanonicalData();
        addNodeToHash(hash, newNode);
        currentNodeIdx = newNode;
    }
  }
  renderBoard();
});
canvas.addEventListener("contextmenu", e => { e.preventDefault(); undoMoves(1); });

function renderBoard() {
  const margin = 50, cell = 50, boardPx = (SIZE - 1) * cell;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#F9EBCF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "black"; ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    const p = margin + i * cell;
    ctx.moveTo(p, margin); ctx.lineTo(p, margin + boardPx);
    ctx.moveTo(margin, p); ctx.lineTo(margin + boardPx, p);
  }
  ctx.stroke();
  ctx.fillStyle = "black";
  [[3,3],[3,11],[7,7],[11,3],[11,11]].forEach(([sx, sy]) => {
    ctx.beginPath(); ctx.arc(margin + sx * cell, margin + sy * cell, 4, 0, Math.PI * 2); ctx.fill();
  });
  if (isPuzzleMode && savedPuzzleState) {
      const snap = savedPuzzleState.gridSnapshot;
      for (let i = 0; i < snap.length; i++) {
          if (snap[i] !== 0) {
              const y = Math.floor(i / SIZE);
              const x = i % SIZE;
              const cx = margin + x * cell, cy = margin + y * cell;
              ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2);
              ctx.fillStyle = (snap[i] === 1) ? "black" : "white"; 
              ctx.fill(); ctx.stroke(); 
          }
      }
  }
  moves.forEach((m, i) => {
    const cx = margin + m.x * cell, cy = margin + m.y * cell;
    ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    let isBlack = (i % 2 === 0);
    if (isPuzzleMode && savedPuzzleState && savedPuzzleState.moves.length % 2 !== 0) {
        isBlack = !isBlack;
    }
    ctx.strokeStyle = (i === moves.length - 1) ? "red" : "black";
    ctx.fillStyle = isBlack ? "black" : "white"; 
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = isBlack ? "white" : "black";
    ctx.font = "bold 20px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.strokeStyle = "black";
    ctx.fillText(i + 1, cx, cy);
  });
  specialClickMap.clear();
  const drawList = [], addedSet = new Set(), renlibMoves = moves.map(m => coordToRenlib(m.x, m.y));
  const checkAndAdd = (idx, tIndex, type) => {
    const invT = TRANSFORMS[INV_INDEX[tIndex]];
    const px = getX(idx), py = getY(idx);
    const [vx, vy] = invT(px, py);
    const rvx = Math.round(vx), rvy = Math.round(vy);
    if (mainBoard.getGridVal(rvx, rvy) !== 0) return;
    const vKey = `${rvx},${rvy}`;
    if (addedSet.has(vKey)) return;
    specialClickMap.set(vKey, { idx: type === 'sym' ? idx : idx }); 
    drawList.push({ x: rvx, y: rvy, type, idx: type==='normal'?idx:null });
    addedSet.add(vKey);
  };
  if (!isPuzzleMode) {
      const currChildren = getChild(currentNodeIdx);
      if (currChildren !== -1) {
        const currGrid = getCanonicalGridFromNodeIdx(currentNodeIdx);
        const transforms = getVisualToTargetTransforms(mainBoard.grid, currGrid);
        if (transforms.length) {
            const prim = transforms.includes(0) ? 0 : transforms[0];
            let c = currChildren;
            while(c !== -1) {
                checkAndAdd(c, prim, 'normal');
                c = getSibling(c);
            }
        }
      }
      const nodes = getNodesFromHash(mainBoard.getCanonicalData().hash);
      if (nodes) {
        for(let nIdx of nodes) {
            const c = nIdx; 
        }
      }
      for (let y=0;y<SIZE;y++) for(let x=0;x<SIZE;x++){
         if(mainBoard.getGridVal(x, y)) continue;
         const vKey = `${x},${y}`;
         if(addedSet.has(vKey)) continue;
         mainBoard.move(x, y);
         const { hash } = mainBoard.getCanonicalData();
         const nodes = getNodesFromHash(hash); 
         mainBoard.undo();
         if(nodes.length > 0) {
             const targetIdx = nodes[0];
             specialClickMap.set(vKey, { idx: targetIdx });
             drawList.push({x, y, type: 'sym', idx: targetIdx});
             addedSet.add(vKey);
         }
      }
  }
  const textCoords = new Set();
  drawList.forEach(d => {
      if(d.idx !== null) {
          if (hasString(d.idx, 'text')) textCoords.add(`${d.x},${d.y}`);
      }
  });
  ctx.lineWidth = 1;
  drawList.forEach(d => {
      if(textCoords.has(`${d.x},${d.y}`)) return;
      const cx = margin + d.x * cell, cy = margin + d.y * cell;
      ctx.fillStyle = (moves.length % 2 === 0) ? (d.type==='normal'?"black":"blue") : (d.type==='normal'?"white":"green");
      ctx.beginPath(); ctx.moveTo(cx + 8, cy); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  drawList.filter(d => d.idx !== null && hasString(d.idx, 'text')).forEach(d => {
      const label = getString(d.idx, 'text');
      const cx = margin + d.x * cell, cy = margin + d.y * cell;
      ctx.font = "bold 24px sans-serif";
      const w = ctx.measureText(label).width;
      ctx.fillStyle = "#F9EBCF"; ctx.fillRect(cx - w/2 - 6, cy - 12 - 6, w + 12, 24 + 12);
      ctx.fillStyle = "magenta"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, cx, cy);
  });
  if (currentNodeIdx !== 0) { elComment.value = getString(currentNodeIdx, 'comment') || ""; elComment.disabled = false; }
  else { elComment.value = ""; elComment.disabled = true; }
  ctx.save(); ctx.font = "bold 20px sans-serif"; ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < SIZE; i++) {
    ctx.fillText(String.fromCharCode(65+i), margin + i * cell, margin + boardPx + 15);
    ctx.textAlign = "right"; ctx.fillText(SIZE - i, margin - 8, margin + i * cell); ctx.textAlign = "center";
  }
  ctx.restore();
  const currentMove = moves.length;
  document.getElementById("lib-info").textContent = `Total Nodes: ${globalNodeCount.toLocaleString()} | Current Move: ${currentMove}` + (isPuzzleMode ? " (Puzzle)" : "");
  if (document.activeElement !== elMoves) elMoves.value = renlibMoves.join("");
  if (document.activeElement !== elSgf) elSgf.value = convertMovesToSgfFromBoard(moves, SIZE);
}
renderBoard();

// --- Comment Box Toggle Logic ---
const commentToggle = document.getElementById("comment-toggle");
const commentBox = document.getElementById("comment-box");
if (commentToggle && commentBox) {
    commentToggle.addEventListener("click", () => {
        commentBox.classList.toggle("collapsed");
    });
}

// --- Save Logic (With Modal) ---
const saveEncodingModal = document.getElementById("saveEncodingModal");
const btnConfirmSaveEncoding = document.getElementById("btnConfirmSaveEncoding");
const btnCancelSaveEncoding = document.getElementById("btnCancelSaveEncoding");
const modalSaveEncodingSelect = document.getElementById("modalSaveEncodingSelect");
const modalSaveFormatSelect = document.getElementById("modalSaveFormatSelect");

document.getElementById("btnSave").addEventListener("click", () => {
    if (modalSaveFormatSelect) {
        modalSaveFormatSelect.value = currentFileFormat;
    }
    saveEncodingModal.classList.remove("hidden");
});

btnCancelSaveEncoding.addEventListener("click", () => {
    saveEncodingModal.classList.add("hidden");
});

function downloadBlob(data, filename, mimeType) {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 0);
}

// Base64変換関数 (スタックオーバーフロー回避版)
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunk = 32768; // 32KBずつ処理
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
    }
    return btoa(binary);
}

// 保存ボタンのイベントリスナー
btnConfirmSaveEncoding.addEventListener("click", async () => {
    saveEncodingModal.classList.add("hidden");
    
    const encoding = modalSaveEncodingSelect.value;
    const format = modalSaveFormatSelect ? modalSaveFormatSelect.value : currentFileFormat;

    try {
        let fileBuffer; // ここには Uint8Array (バイナリ) が入る
        let extension;

        if (format === "db") {
            const writer = new YxdbWriter(encoding);
            writer.build();
            fileBuffer = writer.getBuffer(); 
            extension = "db";
        } else {
            // .lib
            const writer = new RenlibWriter(encoding);
            writer.build();
            fileBuffer = writer.getBuffer(); 
            extension = "lib";
        }

        const now = new Date();
        const ymd = now.toISOString().slice(0,10).replace(/-/g,"");
        const filename = `renju_${ymd}_${now.getHours()}${now.getMinutes()}.${extension}`;

        // --- 保存処理 ---
        try {
            // 1. Capacitor (スマホアプリ) としての保存を試みる
            // Filesystem.writeFile は data に Base64文字列 を要求する
            const base64Data = bufferToBase64(fileBuffer);
            
            await Filesystem.writeFile({
                path: filename,
                data: base64Data,
                directory: Directory.Documents
            });
            alert(`Saved to Documents:\n${filename}`);
            
        } catch (fsErr) {
            // 2. 失敗した場合（またはPCブラウザの場合）はブラウザのダウンロード機能を使う
            console.warn("Filesystem save failed, trying browser download:", fsErr);
            // downloadBlob には Uint8Array をそのまま渡す
            downloadBlob(fileBuffer, filename, "application/octet-stream");
        }

    } catch (e) {
        console.error("Save process failed:", e);
        alert("Save failed: " + e.message);
    }
});

document.getElementById("btnShare").addEventListener("click", async () => {
    const comment = getString(currentNodeIdx, 'comment') || "";
    await shareBoardImage(canvas, comment);
});

function wrapText(ctx, text, x, y, maxWidth, lineHeight, draw = false) {
    const chars = text.split('');
    let line = '';
    let currentY = y;
    for (let n = 0; n < chars.length; n++) {
        const testLine = line + chars[n];
        const metrics = ctx.measureText(testLine);
        const testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
            if(draw) ctx.fillText(line, x, currentY);
            line = chars[n];
            currentY += lineHeight;
        } else {
            line = testLine;
        }
    }
    if(draw) ctx.fillText(line, x, currentY);
    return currentY + lineHeight;
}

async function shareBoardImage(sourceCanvas, comment) {
    try {
        let dataUrl;
        if (!comment || comment.trim() === "") {
            dataUrl = sourceCanvas.toDataURL("image/png");
        } 
        else {
            const padding = 20;
            const fontSize = 24;
            const lineHeight = 36;
            const boardSize = sourceCanvas.width;
            const measureCanvas = document.createElement("canvas");
            const mCtx = measureCanvas.getContext("2d");
            mCtx.font = `${fontSize}px sans-serif`;
            const textAreaWidth = boardSize - (padding * 2);
            const textHeight = wrapText(mCtx, comment, 0, 0, textAreaWidth, lineHeight, false);
            const totalHeight = boardSize + textHeight + (padding * 2);
            const genCanvas = document.createElement("canvas");
            genCanvas.width = boardSize;
            genCanvas.height = totalHeight;
            const ctx = genCanvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, genCanvas.width, genCanvas.height);
            ctx.drawImage(sourceCanvas, 0, 0);
            ctx.fillStyle = "#333333";
            ctx.font = `${fontSize}px sans-serif`;
            ctx.textBaseline = "top";
            ctx.strokeStyle = "#cccccc";
            ctx.beginPath();
            ctx.moveTo(padding, boardSize + padding / 2);
            ctx.lineTo(boardSize - padding, boardSize + padding / 2);
            ctx.stroke();
            wrapText(ctx, comment, padding, boardSize + padding, textAreaWidth, lineHeight, true);
            dataUrl = genCanvas.toDataURL("image/png");
        }
        const fileName = `renju_share_${Date.now()}.png`;
        const base64Data = dataUrl.split(',')[1];
        const savedFile = await Filesystem.writeFile({
            path: fileName,
            data: base64Data,
            directory: Directory.Cache
        });
        await Share.share({
            title: 'Renju Board',
            text: comment ? comment : 'Renju Board',
            files: [savedFile.uri]
        });
    } catch (e) {
        console.error("Share failed", e);
        alert("Sharing failed: " + e.message);
    }
}

// --- About & Settings Logic ---
const aboutModal = document.getElementById("aboutModal");
const btnAbout = document.getElementById("btnAbout");
const spanClose = document.getElementById("closeModal");

// ★ボタンが存在するかチェックしてからイベント登録
if (btnAbout) {
    btnAbout.addEventListener("click", () => {
        if(aboutModal) aboutModal.classList.remove("hidden");
    });
}
if (spanClose) {
    spanClose.addEventListener("click", () => {
        if(aboutModal) aboutModal.classList.add("hidden");
    });
}

// Settings Modal Logic
const settingsModal = document.getElementById("settingsModal");
const btnSettings = document.getElementById("btnSettings");
const btnSaveSettings = document.getElementById("btnSaveSettings");
const maxNodesSelect = document.getElementById("maxNodesSelect");
const maxNodesInput = document.getElementById("maxNodesInput");
const chkSaveSettings = document.getElementById("chkSaveSettings");

// アプリ起動時に保存された設定を読み込む
function loadSettings() {
    const savedMaxNodes = localStorage.getItem("renju_max_nodes");
    if (savedMaxNodes) {
        const val = parseInt(savedMaxNodes, 10);
        if (val > 0) {
            currentMaxNodes = val;
            console.log(`Loaded saved MaxNodes: ${currentMaxNodes}`);
        }
    }
}
loadSettings(); 

if (btnSettings && settingsModal) {
    btnSettings.addEventListener("click", () => {
        if (maxNodesInput) maxNodesInput.value = currentMaxNodes.toString();
        
        const saved = localStorage.getItem("renju_max_nodes");
        if (chkSaveSettings) {
            chkSaveSettings.checked = (saved !== null);
        }
        
        settingsModal.classList.remove("hidden");
    });
    
    // Sync Select -> Input
    if (maxNodesSelect && maxNodesInput) {
        maxNodesSelect.addEventListener("change", () => {
            if (maxNodesSelect.value) {
                maxNodesInput.value = maxNodesSelect.value;
            }
        });
    }
    
    btnSaveSettings.addEventListener("click", () => {
        const val = parseInt(maxNodesInput.value, 10);
        if (val > 0) {
            currentMaxNodes = val;
            
            if (chkSaveSettings && chkSaveSettings.checked) {
                localStorage.setItem("renju_max_nodes", val.toString());
            } else {
                localStorage.removeItem("renju_max_nodes");
            }
        }
        settingsModal.classList.add("hidden");
    });
}

// Global click to close any modal
window.addEventListener("click", (e) => {
    if (e.target === aboutModal) aboutModal.classList.add("hidden");
    if (e.target === settingsModal) settingsModal.classList.add("hidden");
    if (e.target === encodingModal) encodingModal.classList.add("hidden");
    if (e.target === saveEncodingModal) saveEncodingModal.classList.add("hidden");
});