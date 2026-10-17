'use strict';
/**
 * 随机访问 ZIP 读取器，零依赖：deflate 走 Node 自带的 zlib.inflateRawSync。
 * 只读用到的条目，不把整包读进内存；输入可为文件路径或 Buffer（后者用于读 jar 内部）。
 * 支持 Zip64、前置数据偏移（自解压包）；加密条目直接报错。
 */
const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LFH = 0x04034b50;
const U16 = 0xffff;
const U32 = 0xffffffff;

class ZipReader {
  /** @param {string|Buffer} src 文件路径或内存中的 zip 字节 */
  constructor(src) {
    if (Buffer.isBuffer(src)) {
      this.buf = src;
      this.fd = -1;
    } else {
      this.buf = null;
      this.fd = fs.openSync(String(src), 'r');
      this.path = String(src);
    }
    this.size = this.fd < 0 ? this.buf.length : fs.fstatSync(this.fd).size;
    this.map = new Map();
    try {
      this._parse();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close() {
    if (this.fd >= 0) {
      try { fs.closeSync(this.fd); } catch { /* 已关闭 */ }
      this.fd = -1;
    }
  }

  names() { return [...this.map.keys()]; }
  has(name) { return this.map.has(name); }
  /** 文件在 zip 中的原始字节数（未解压前的大小） */
  sizeOf(name) {
    const e = this.map.get(name);
    return e ? e.usize : -1;
  }
  /** 按顺序返回第一个存在的名字；都没有则返回 null */
  pick(...names) {
    for (const n of names) if (this.map.has(n)) return n;
    return null;
  }
  read(name) {
    const e = this.map.get(name);
    if (!e) throw new Error(`zip 中不存在条目: ${name}`);
    return this._entry(e);
  }
  tryRead(name) {
    return this.map.has(name) ? this._entry(this.map.get(name)) : null;
  }

  /** 读文件任意区间；fd 模式下用 pread，不移动文件位置 */
  _at(off, len) {
    if (off < 0 || len < 0 || off + len > this.size) {
      throw new Error(`zip 读取越界: ${off}+${len} > ${this.size}`);
    }
    if (this.fd < 0) return this.buf.subarray(off, off + len);
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, b, got, len - got, off + got);
      if (n <= 0) throw new Error('zip 读取提前结束');
      got += n;
    }
    return b;
  }

  /** EOCD 在文件尾部 22 + 最多 65535 字节注释内，从后往前找 */
  _eocdOffset() {
    const len = Math.min(this.size, 22 + U16);
    const tail = this._at(this.size - len, len);
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      // 注释长度必须正好收到文件尾，否则是数据区里的假签名
      if (i + 22 + tail.readUInt16LE(i + 20) === tail.length) return this.size - len + i;
    }
    throw new Error('不是有效的 zip：找不到 EOCD');
  }

  _parse() {
    const eocd = this._eocdOffset();
    const e = this._at(eocd, 22);
    let total = e.readUInt16LE(10);
    let cdSize = e.readUInt32LE(12);
    let cdOff = e.readUInt32LE(16);
    let ref = eocd;

    if (total === U16 || cdSize === U32 || cdOff === U32) {
      const loc = this._at(eocd - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_LOC64) throw new Error('zip64 定位符缺失');
      ref = Number(loc.readBigUInt64LE(8));
      const z = this._at(ref, 56);
      if (z.readUInt32LE(0) !== SIG_EOCD64) throw new Error('zip64 EOCD 缺失');
      total = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOff = Number(z.readBigUInt64LE(48));
    }

    // 中央目录的逻辑位置与物理位置之差 = 包前的额外数据长度
    this.base = Math.max(0, ref - cdSize - cdOff);
    const cd = this._at(cdOff + this.base, cdSize);
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CD) {
        throw new Error(`中央目录第 ${i} 条损坏`);
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let off = cd.readUInt32LE(p + 42);
      // 整合包一律按 UTF-8 解条目名（写入方均置语言编码标志位）
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

      if (usize === U32 || csize === U32 || off === U32) {
        let q = p + 46 + nameLen;
        const end = q + extraLen;
        while (q + 4 <= end) {
          const id = cd.readUInt16LE(q);
          const sz = cd.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            // zip64 扩展字段只补被置为 0xffffffff 的那几项，顺序固定
            if (usize === U32) { usize = Number(cd.readBigUInt64LE(r)); r += 8; }
            if (csize === U32) { csize = Number(cd.readBigUInt64LE(r)); r += 8; }
            if (off === U32) { off = Number(cd.readBigUInt64LE(r)); r += 8; }
            break;
          }
          q += 4 + sz;
        }
        if (usize === U32 || csize === U32 || off === U32) {
          throw new Error(`zip64 扩展字段不完整: ${name}`);
        }
      }
      this.map.set(name, { name, usize, csize, method, flags, off });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  _entry(e) {
    if (e.flags & 1) throw new Error(`条目已加密，无法读取: ${e.name}`);
    const lh = this._at(e.off + this.base, 30);
    if (lh.readUInt32LE(0) !== SIG_LFH) throw new Error(`本地头签名错误: ${e.name}`);
    // 本地头的名称/扩展字段长度可能不同于中央目录，必须以本地头为准定位数据
    const start = e.off + this.base + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = this._at(start, e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`不支持的压缩方法 ${e.method}: ${e.name}`);
    let out;
    try {
      out = zlib.inflateRawSync(raw);
    } catch (err) {
      throw new Error(`解压失败 ${e.name}: ${err.message}`);
    }
    if (out.length !== e.usize) throw new Error(`解压长度不符: ${e.name}`);
    return out;
  }
}

module.exports = { ZipReader };
