/* 현장 사진 처리 (PRD 8절 Photo) — 긴 변 1600px 수준으로 축소한 파생본만 저장한다.
 * 사용자 기기의 원본 파일은 건드리지 않는다.
 */
(function (global) {
  'use strict';

  var MAX_EDGE = 1600;
  // Pl@ntNet 권장값이 품질 90% 정도다. 서버가 긴 변을 1280px로 줄이므로 해상도는 넉넉하고,
  // 800x800보다 작으면 식별 성능이 보장되지 않는다.
  var JPEG_QUALITY = 0.9;
  var MIN_GOOD_EDGE = 800;

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var url = global.URL.createObjectURL(file);
      var img = new global.Image();
      img.onload = function () {
        global.URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        global.URL.revokeObjectURL(url);
        reject(new Error('사진 파일을 열지 못했습니다. 다른 사진으로 시도해 주세요.'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, mimeType, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('사진을 저장용으로 바꾸지 못했습니다.'));
        }, mimeType, quality);
      } else {
        reject(new Error('이 브라우저에서 사진 변환을 지원하지 않습니다.'));
      }
    });
  }

  /** 파일 하나를 저장 가능한 Photo 레코드로 바꾼다. */
  function prepare(file, observationId) {
    if (!file || !/^image\//.test(file.type || '')) {
      return Promise.reject(new Error('이미지 파일만 첨부할 수 있습니다.'));
    }
    return readImage(file).then(function (img) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('사진 크기를 읽지 못했습니다.');
      var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      var outW = Math.max(1, Math.round(w * scale));
      var outH = Math.max(1, Math.round(h * scale));
      var canvas = global.document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('이 브라우저에서 사진을 처리할 수 없습니다.');
      ctx.drawImage(img, 0, 0, outW, outH);
      return canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY).then(function (blob) {
        return {
          id: uuid(),
          observationId: observationId,
          blob: blob,
          mimeType: 'image/jpeg',
          width: outW,
          height: outH,
          createdAt: new Date().toISOString()
        };
      });
    });
  }

  /** 켜져 있는 카메라 화면에서 한 장을 떠낸다. 저장 규격은 파일 첨부와 같다. */
  function captureFromVideo(video, observationId) {
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (!w || !h) return Promise.reject(new Error('카메라 화면이 아직 준비되지 않았습니다.'));
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    var outW = Math.max(1, Math.round(w * scale));
    var outH = Math.max(1, Math.round(h * scale));
    var canvas = global.document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('이 브라우저에서 사진을 처리할 수 없습니다.'));
    ctx.drawImage(video, 0, 0, outW, outH);
    return canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY).then(function (blob) {
      return {
        id: uuid(),
        observationId: observationId,
        blob: blob,
        mimeType: 'image/jpeg',
        width: outW,
        height: outH,
        createdAt: new Date().toISOString()
      };
    });
  }

  function objectUrl(photo) {
    if (!photo || !photo.blob) return '';
    return global.URL.createObjectURL(photo.blob);
  }

  /** 식별에 쓰기엔 너무 작은 사진인지. 경고만 하고 막지는 않는다. */
  function isTooSmallForId(photo) {
    if (!photo) return false;
    return Math.min(photo.width || 0, photo.height || 0) < MIN_GOOD_EDGE;
  }

  global.BibimPhoto = {
    MAX_EDGE: MAX_EDGE,
    MIN_GOOD_EDGE: MIN_GOOD_EDGE,
    isTooSmallForId: isTooSmallForId,
    uuid: uuid,
    prepare: prepare,
    captureFromVideo: captureFromVideo,
    objectUrl: objectUrl
  };
})(window);
