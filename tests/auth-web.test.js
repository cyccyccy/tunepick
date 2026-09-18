'use strict';
// 临时验证脚本：检查 Web 鉴权改造后的四条路径（用完即删）
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
process.env.MUSIC_DIR = require('path').join(__dirname, '..', 'tests', 'fixtures', 'music');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-auth-test');

const fs = require('fs');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const auth = require('../src/api/auth');
const { route } = require('../src/api/index');

function req(headers, pathname = '/') {
  return { headers, method: 'GET', socket: { remoteAddress: '192.168.2.1' }, url: pathname };
}
function res() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => { r.status = s; if (h) Object.assign(r.headers, h); };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b || ''; };
  return r;
}
const basic = 'Basic ' + Buffer.from('admin:admin').toString('base64');

(async () => {
  const cases = [
    ['无凭据 + 浏览器(Expect HTML)', req({ accept: 'text/html' }), '/', '302 到 /login'],
    ['无凭据 + 非浏览器', req({ accept: 'application/json' }), '/', '401'],
    ['Cookie tp_token 正确', req({ accept: 'text/html', cookie: 'tp_token=testtoken' }), '/', '200 index.html'],
    ['Cookie tp_token 错误', req({ accept: 'text/html', cookie: 'tp_token=wrong' }), '/', '302 到 /login'],
    ['Basic admin 正确', req({ accept: 'text/html', authorization: basic }), '/', '200 index.html'],
    ['Bearer 正确(页面)', req({ accept: 'text/html', authorization: 'Bearer testtoken' }), '/', '200 index.html'],
    ['登录页可匿名访问', req({ accept: 'text/html' }), '/login', '200 login.html'],
    ['API 无 Bearer', req({ authorization: basic }), '/api/sources', '401'],
    ['API Bearer 正确', req({ authorization: 'Bearer testtoken' }), '/api/sources', '200'],
  ];

  let fail = 0;
  for (const [name, r, p, expect] of cases) {
    const out = res();
    let ok = true, err = '';
    try { await route(r, out, 'GET', p, new URL('http://x' + p)); }
    catch (e) { ok = false; err = e.message; }
    const got = out.status === 302 ? '302 到 ' + out.headers.Location : String(out.status) +
      (out.body && /<title>/.test(out.body) ? ' ' + (/TunePick · 登录/.test(out.body) ? 'login.html' : 'index.html') : '');
    const pass = got === expect && ok;
    if (!pass) fail++;
    console.log((pass ? '✅ ' : '❌ ') + name.padEnd(26) + ' → ' + got + (pass ? '' : '  (期望 ' + expect + ')' + (err ? ' err=' + err : '')));
  }

  console.log('\ncheckWeb 单元检查:');
  console.log('  cookie 命中 :', auth.checkWeb(req({ cookie: 'tp_token=testtoken' })) === true);
  console.log('  cookie 混杂 :', auth.checkWeb(req({ cookie: 'a=1; tp_token=testtoken; b=2' })) === true);
  console.log('  无凭据      :', auth.checkWeb(req({})) === false);
  console.log('\n失败数:', fail);
  process.exit(fail ? 1 : 0);
})();
