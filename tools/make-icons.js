/* 홈 화면 아이콘(PNG)을 만든다. 외부 라이브러리 없이 zlib만 쓴다.
 * 실행: node tools/make-icons.js
 * 색을 바꾸려면 아래 BG/LEAF 값을 고치고 다시 실행한다. 결과는 images/ 에 덮어쓴다.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var BG = [0x1f, 0x6f, 0x4a];      // styles.css 의 --brand
var LEAF = [0xe9, 0xf6, 0xee];    // --green-bg
var OUT = path.resolve(__dirname, '..', 'images');

/* ── PNG 인코더 (RGBA, 필터 0) ───────────────────────────────── */

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n += 1) {
    var c = n;
    for (var k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  var typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function encodePng(width, height, rgba) {
  var raw = Buffer.alloc((width * 4 + 1) * height);
  for (var y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;   // 필터 없음
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── 그리기 ──────────────────────────────────────────────────── */

/** 둥근 사각형 안쪽인가. radius 0 이면 사각형 전체. */
function inRoundedRect(x, y, size, radius) {
  var r = radius;
  if (r <= 0) return true;
  var cx = Math.min(Math.max(x, r), size - r);
  var cy = Math.min(Math.max(y, r), size - r);
  var dx = x - cx;
  var dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 잎 모양 안쪽인가. 중심에서 -40도 기울인 뾰족한 타원이다.
 * half 는 잎 길이의 절반(픽셀), ratio 는 폭/길이 비율.
 */
function inLeaf(x, y, size, half, ratio) {
  var angle = -40 * Math.PI / 180;
  var dx = x - size / 2;
  var dy = y - size / 2;
  var u = dx * Math.cos(angle) + dy * Math.sin(angle);
  var v = -dx * Math.sin(angle) + dy * Math.cos(angle);
  if (Math.abs(u) > half) return false;
  var t = 1 - (u / half) * (u / half);
  var width = half * ratio * Math.pow(t, 0.8);   // 지수 > 0.5 라서 양 끝이 뾰족해진다
  return Math.abs(v) <= width;
}

/** 잎 가운데 잎맥. 배경색으로 그어 잎을 둘로 나눈다. */
function inMidrib(x, y, size, half, thickness) {
  var angle = -40 * Math.PI / 180;
  var dx = x - size / 2;
  var dy = y - size / 2;
  var u = dx * Math.cos(angle) + dy * Math.sin(angle);
  var v = -dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(u) <= half * 0.92 && Math.abs(v) <= thickness;
}

/**
 * 아이콘 한 장을 만든다.
 * leafScale: 잎 길이 / 변 길이. 마스커블 아이콘은 원형으로 잘려도 남게 작게 쓴다.
 * cornerRatio: 모서리 반지름 / 변 길이. 마스커블은 0(정사각형)으로 둔다.
 */
function render(size, leafScale, cornerRatio) {
  var rgba = Buffer.alloc(size * size * 4);
  var half = size * leafScale / 2;
  var radius = size * cornerRatio;
  var thickness = Math.max(1, size * 0.008);
  var SS = 3;   // 3x3 과표본으로 계단을 없앤다

  for (var y = 0; y < size; y += 1) {
    for (var x = 0; x < size; x += 1) {
      var bgHits = 0;
      var leafHits = 0;
      for (var sy = 0; sy < SS; sy += 1) {
        for (var sx = 0; sx < SS; sx += 1) {
          var px = x + (sx + 0.5) / SS;
          var py = y + (sy + 0.5) / SS;
          if (!inRoundedRect(px, py, size, radius)) continue;
          bgHits += 1;
          if (inLeaf(px, py, size, half, 0.42) && !inMidrib(px, py, size, half, thickness)) leafHits += 1;
        }
      }
      var total = SS * SS;
      var alpha = bgHits / total;
      var leafMix = bgHits ? leafHits / bgHits : 0;
      var at = (y * size + x) * 4;
      for (var c = 0; c < 3; c += 1) {
        rgba[at + c] = Math.round(BG[c] * (1 - leafMix) + LEAF[c] * leafMix);
      }
      rgba[at + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

var jobs = [
  { file: 'icon-192.png', size: 192, leaf: 0.74, corner: 0.22 },
  { file: 'icon-512.png', size: 512, leaf: 0.74, corner: 0.22 },
  // 마스커블: 기기가 원형으로 잘라내므로 안쪽 80%(안전 영역)에만 그린다.
  { file: 'icon-maskable-512.png', size: 512, leaf: 0.56, corner: 0 }
];

jobs.forEach(function (job) {
  var png = render(job.size, job.leaf, job.corner);
  fs.writeFileSync(path.join(OUT, job.file), png);
  console.log(job.file + ' — ' + job.size + 'x' + job.size + ', ' + png.length + ' B');
});
