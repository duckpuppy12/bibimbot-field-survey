/* 현장 사진 처리 (PRD 8절 Photo) — 긴 변 1600px 수준으로 축소한 파생본만 저장한다.
 * 사용자 기기의 원본 파일은 건드리지 않는다.
 */
(function (global) {
  'use strict';

  var MAX_EDGE = 1600;
  var JPEG_QUALITY = 0.82;

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

  global.BibimPhoto = {
    MAX_EDGE: MAX_EDGE,
    uuid: uuid,
    prepare: prepare,
    captureFromVideo: captureFromVideo,
    objectUrl: objectUrl
  };
})(window);
