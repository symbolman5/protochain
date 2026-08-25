/**
 * @exodus/bytes/encoding-lite.js 的 CJS 垫片（jest 专用）
 *
 * 背景：jsdom@>=24 的依赖树经 html-encoding-sniffer 引用 @exodus/bytes
 * （ESM-only 包），而本项目的 jest 走 ts-jest（CJS 运行时）且不引入 babel
 * 转译 node_modules——ESM 语法会让 jest-runtime 直接报 "Unexpected token export"。
 *
 * 方案：jest moduleNameMapper 把 @exodus/bytes/encoding-lite.js 映射到本文件
 * （语义对齐原实现：WHATWG 编码标准常用标签 + BOM 检测；jsdom 冒烟足够）。
 *
 * 原实现参考：node_modules/@exodus/bytes/fallback/encoding.{js,api.js}
 */
'use strict';

// WHATWG Encoding Standard 常用标签 → 规范名（精简自原实现 labels 表）
const LABELS = {
  'unicode-1-1-utf-8': 'utf-8',
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'ibm866': 'ibm866',
  '866': 'ibm866',
  'cp866': 'ibm866',
  'csibm866': 'ibm866',
  'iso-8859-2': 'iso-8859-2',
  'iso8859-2': 'iso-8859-2',
  'latin2': 'iso-8859-2',
  'l2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso8859-5': 'iso-8859-5',
  'cyrillic': 'iso-8859-5',
  'iso-8859-15': 'iso-8859-15',
  'iso8859-15': 'iso-8859-15',
  'latin9': 'iso-8859-15',
  'koi8-r': 'koi8-r',
  'koi8r': 'koi8-r',
  'koi8': 'koi8-r',
  'gbk': 'gbk',
  'gb2312': 'gbk',
  'csgb2312': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big5-hkscs': 'big5',
  'cn-big5': 'big5',
  'shift_jis': 'shift_jis',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  'csshiftjis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'eucjp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'euckr': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'windows-874': 'windows-874',
  'dos-874': 'windows-874',
  'iso-8859-11': 'windows-874',
  'windows-1250': 'windows-1250',
  'cp1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'cp1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'cp1252': 'windows-1252',
  'ascii': 'windows-1252',
  'us-ascii': 'windows-1252',
  'latin1': 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'iso88591': 'windows-1252',
  'l1': 'windows-1252',
  'windows-1256': 'windows-1256',
  'cp1256': 'windows-1256',
  'utf-16le': 'utf-16le',
  'utf-16': 'utf-16le',
  'ucs-2': 'utf-16le',
  'ucs2': 'utf-16le',
  'utf-16be': 'utf-16be',
};

function normalizeEncoding(label) {
  if (label === 'utf-8' || label === 'utf8' || label === 'UTF-8' || label === 'UTF8') {
    return 'utf-8';
  }
  if (label === 'windows-1252' || label === 'ascii' || label === 'latin1') {
    return 'windows-1252';
  }
  if (typeof label !== 'string') return null;
  // 必须为 ASCII（含 ASCII 空白）
  if (/[^\w\t\n\f\r .:-]/i.test(label)) return null;
  const low = label.trim().toLowerCase();
  return Object.hasOwn(LABELS, low) ? LABELS[low] : null;
}

function labelToName(label) {
  const enc = normalizeEncoding(label);
  if (enc === 'utf-8') return 'UTF-8'; // fast path
  if (!enc) return enc;
  if (/^(utf|iso|koi|euc|ibm|gbk)/.test(enc.slice(0, 3)) || /^(utf|iso|koi|euc|ibm|gbk)/.test(enc)) {
    return enc.toUpperCase();
  }
  if (enc === 'big5') return 'Big5';
  if (enc === 'shift_jis') return 'Shift_JIS';
  return enc;
}

function getBOMEncoding(input) {
  const u8 =
    input instanceof Uint8Array
      ? input
      : typeof input === 'string'
        ? new TextEncoder().encode(input)
        : null;
  if (!u8) return null;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return 'utf-8';
  if (u8.length < 2) return null;
  if (u8[0] === 0xff && u8[1] === 0xfe) return 'utf-16le';
  if (u8[0] === 0xfe && u8[1] === 0xff) return 'utf-16be';
  return null;
}

module.exports = { normalizeEncoding, getBOMEncoding, labelToName };
