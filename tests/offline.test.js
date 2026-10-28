/* 오프라인 보관이 실제로 성립하는지 확인한다.
 *
 * sw.js 의 PRECACHE 는 "한 장이라도 실패하면 설치 실패"다. 파일 이름을 고치거나
 * 새 파일을 더하고 목록을 안 고치면 현장에서야 "앱이 안 열린다"로 드러난다.
 * 그 어긋남을 여기서 먼저 잡는다.
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** sw.js 안의 PRECACHE 배열을 읽어 온다. */
function precacheList() {
  var code = read('sw.js');
  var match = /var PRECACHE = \[([\s\S]*?)\];/.exec(code);
  assert.ok(match, 'sw.js 에서 PRECACHE 목록을 찾지 못했다');
  return match[1]
    .split(',')
    .map(function (line) { return line.replace(/\/\/.*$/gm, '').trim(); })
    .filter(Boolean)
    .map(function (item) { return item.replace(/^['"]|['"]$/g, ''); });
}

test('PRECACHE 에 적힌 파일이 모두 실제로 있다', function () {
  precacheList().forEach(function (entry) {
    if (entry === './') return;      // 시작 주소는 index.html 로 응답한다
    assert.ok(fs.existsSync(path.join(ROOT, entry)), entry + ' 가 저장소에 없다');
  });
});

test('index.html 이 불러오는 같은 출처 파일이 모두 PRECACHE 에 있다', function () {
  var html = read('index.html');
  var cached = precacheList();
  var referenced = [];

  var scriptRe = /<script[^>]+src="([^"]+)"/g;
  var linkRe = /<link[^>]+href="([^"]+)"/g;
  var match;
  while ((match = scriptRe.exec(html))) referenced.push(match[1]);
  while ((match = linkRe.exec(html))) referenced.push(match[1]);

  referenced
    .filter(function (url) { return !/^https?:|^data:|^\/\//.test(url); })
    .forEach(function (url) {
      assert.ok(cached.indexOf(url) !== -1, url + ' 이 sw.js 의 PRECACHE 에 빠져 있다');
    });
});

test('src/ 의 모든 모듈이 PRECACHE 에 있다', function () {
  var cached = precacheList();
  fs.readdirSync(path.join(ROOT, 'src')).filter(function (name) {
    return /\.js$/.test(name);
  }).forEach(function (name) {
    assert.ok(cached.indexOf('src/' + name) !== -1, 'src/' + name + ' 이 PRECACHE 에 빠져 있다');
  });
});

test('도감 참고 그림이 모두 PRECACHE 에 있다', function () {
  var cached = precacheList();
  var plants = read('src/plants.js');
  var re = /referenceImage: '([^']+)'/g;
  var match;
  var found = 0;
  while ((match = re.exec(plants))) {
    found += 1;
    assert.ok(cached.indexOf(match[1]) !== -1, match[1] + ' 이 PRECACHE 에 빠져 있다');
    assert.ok(fs.existsSync(path.join(ROOT, match[1])), match[1] + ' 파일이 없다');
  }
  assert.ok(found > 0, '참고 그림을 한 장도 찾지 못했다');
});

test('sw.js 의 VERSION 과 app.js 의 BUILD 가 같다', function () {
  // 두 값이 어긋나면 자가 진단의 "오프라인 캐시" 줄이 영영 빌드와 다르다고 나온다.
  var swVersion = /var VERSION = '([^']+)'/.exec(read('sw.js'));
  var appBuild = /var BUILD = '([^']+)'/.exec(read('src/app.js'));

  assert.ok(swVersion, 'sw.js 에서 VERSION 을 찾지 못했다');
  assert.ok(appBuild, 'src/app.js 에서 BUILD 를 찾지 못했다');
  assert.equal(swVersion[1], appBuild[1], '고칠 때 둘을 같이 올려야 한다');
});

test('manifest 가 가리키는 아이콘이 모두 있다', function () {
  var manifest = JSON.parse(read('manifest.webmanifest'));
  var cached = precacheList();

  assert.ok(manifest.icons.length >= 2, '192·512 아이콘은 있어야 설치 배너가 뜬다');
  manifest.icons.forEach(function (icon) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src + ' 파일이 없다');
    assert.ok(cached.indexOf(icon.src) !== -1, icon.src + ' 이 PRECACHE 에 빠져 있다');
  });
  assert.ok(manifest.icons.some(function (icon) { return /maskable/.test(icon.purpose || ''); }),
    'Android 홈 화면용 maskable 아이콘이 있어야 한다');
  assert.equal(manifest.start_url, '.', 'GitHub Pages 하위 경로에서도 열리도록 상대 주소로 둔다');
});

test('index.html 이 manifest 와 서비스 워커를 실제로 물고 있다', function () {
  var html = read('index.html');
  assert.ok(/rel="manifest"/.test(html), 'manifest 링크가 없으면 설치가 안 된다');
  assert.ok(/name="theme-color"/.test(html));
  assert.ok(/register\('sw\.js'\)/.test(read('src/app.js')), '서비스 워커 등록이 app.js 에 있어야 한다');
});

test('서비스 워커가 바깥 주소를 건드리지 않는다', function () {
  var code = read('sw.js');
  // OSM 타일 정책: 미리 받기·대량 내려받기 금지. 바깥 출처는 통과시키기만 한다.
  assert.ok(/url\.origin !== self\.location\.origin/.test(code), '바깥 출처를 걸러내는 줄이 있어야 한다');
  assert.equal(/tile\.openstreetmap\.org/.test(code.replace(/^\s*\*.*$/gm, '')), false,
    '타일 주소를 캐시 목록에 넣으면 타일 정책 위반이다');
});
