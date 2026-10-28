/* 테스트에서 src/ 모듈을 불러오는 도우미.
 *
 * 앱 모듈은 모두 `(function (global) { ... })(window)` 모양이라, 가짜 window 하나만
 * 만들어 넘겨 주면 브라우저 없이도 그대로 돌릴 수 있다. 번들러도 의존성도 필요 없다.
 *
 * 실행: node --test tests/
 */
'use strict';

var fs = require('node:fs');
var path = require('node:path');

var SRC = path.resolve(__dirname, '..', 'src');

/** 모듈이 기대하는 브라우저 전역을 최소한으로 흉내 낸 객체. */
function makeWindow(overrides) {
  var settings = {};
  var win = {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Blob: Blob,
    FormData: global.FormData,
    console: console,
    isSecureContext: true,
    navigator: { onLine: true, userAgent: 'node-test' },
    location: { href: 'https://example.test/', hostname: 'example.test' },
    atob: function (text) { return Buffer.from(text, 'base64').toString('binary'); },
    btoa: function (text) { return Buffer.from(text, 'binary').toString('base64'); }
  };
  win.window = win;

  // 설정 저장소(localStorage 자리). 테스트에서 win.__settings 로 직접 건드린다.
  win.__settings = settings;
  win.BibimStorage = {
    getSetting: function (key, fallback) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
    },
    setSetting: function (key, value) { settings[key] = value; return true; },
    removeSetting: function (key) { delete settings[key]; }
  };

  Object.keys(overrides || {}).forEach(function (key) { win[key] = overrides[key]; });
  return win;
}

/**
 * 모듈을 순서대로 같은 window 에 올린다.
 * @param names ['plants', 'catalog', ...] — src/ 안의 파일 이름(확장자 없이)
 */
function load(names, overrides) {
  var win = makeWindow(overrides);
  names.forEach(function (name) {
    var file = path.join(SRC, name + '.js');
    var code = fs.readFileSync(file, 'utf8');
    // sourceURL 을 붙여 두면 오류 스택에 파일 이름이 그대로 나온다.
    new Function('window', code + '\n//# sourceURL=' + file)(win);
  });
  return win;
}

/** 도감까지 초기화해서 바로 쓸 수 있는 window 를 준다. */
function loadCatalog(extraModules, overrides) {
  var win = load(['plants', 'catalog'].concat(extraModules || []), overrides);
  win.BibimCatalog.init({});
  return win;
}

module.exports = { SRC: SRC, load: load, loadCatalog: loadCatalog, makeWindow: makeWindow };
