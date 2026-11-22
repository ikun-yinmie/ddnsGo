const ADMIN_HOST = 'admin.example.net';
const CONFIG_KEY = 'config';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_CONFIG = {
  version: 1,
  updatedAt: null,
  settings: {
    baseDomain: 'example.net',
    directTimeoutMs: 1500,
    cfTimeoutMs: 2800,
  },
  aliases: {
    www: 'onenav',
  },
  services: {
    onenav: {
      name: 'OneNav 导航',
      enabled: true,
      icon: '/favicon.ico',
      cf: ['https://onenav.example.net', 'https://www.example.com'],
      v6: ['https://www.example.org', 'https://onenav.example.org'],
    },
    pan: {
      name: '网盘',
      enabled: true,
      icon: '/static/img/favicon.ico',
      cf: ['https://cloudpan.example.net', 'https://pan.example.com'],
      v6: ['https://pan.example.org'],
    },
    note: {
      name: '笔记',
      enabled: true,
      icon: '/apple-touch-icon.png',
      cf: ['https://note.example.net', 'https://note.example.com'],
      v6: ['https://note.example.org'],
    },
    lsky: {
      name: '图床',
      enabled: true,
      icon: '/favicon.ico',
      cf: ['https://lsky.example.net', 'https://lsky.example.com'],
      v6: ['https://lsky.example.org'],
    },
    xc: {
      name: 'POETIZE',
      enabled: true,
      icon: '/poetize.jpg',
      cf: ['https://xc.example.net', 'https://xc.example.com'],
      v6: ['https://xc.example.org'],
    },
  },
};

const enc = new TextEncoder();
const H = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const J = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const RESERVED_LABELS = new Set(['admin']);

function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function validIcon(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  if (value.startsWith('/') && !value.startsWith('//') && !/\s/.test(value)) return true;
  return isHttpsUrl(value);
}

function cleanUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { config: null, errors: ['配置必须是一个 JSON 对象'] };
  }

  const errors = [];
  const config = {
    version: 1,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    settings: clone(DEFAULT_CONFIG.settings),
    aliases: {},
    services: {},
  };

  const s = input.settings;
  if (s && typeof s === 'object') {
    if (typeof s.baseDomain === 'string' && /^[a-z0-9.-]{3,80}$/.test(s.baseDomain.trim().toLowerCase())) {
      config.settings.baseDomain = s.baseDomain.trim().toLowerCase();
    }
    const direct = Number(s.directTimeoutMs);
    if (Number.isFinite(direct) && direct >= 300 && direct <= 5000) {
      config.settings.directTimeoutMs = Math.round(direct);
    }
    const cf = Number(s.cfTimeoutMs);
    if (Number.isFinite(cf) && cf >= 500 && cf <= 8000) {
      config.settings.cfTimeoutMs = Math.round(cf);
    }
  }

  const services = input.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    errors.push('services 必须是一个对象');
  } else {
    const keys = Object.keys(services);
    if (keys.length > 50) errors.push('服务数量不能超过 50 个');
    for (const key of keys) {
      if (!LABEL_RE.test(key)) {
        errors.push(`服务键 "${key}" 不合法（小写字母/数字/短横线，最长 31）`);
        continue;
      }
      if (RESERVED_LABELS.has(key)) {
        errors.push(`服务键 "${key}" 是保留名`);
        continue;
      }
      const raw = services[key];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`服务 "${key}" 的配置不是对象`);
        continue;
      }
      const svc = {
        name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : key,
        enabled: raw.enabled !== false,
        icon: validIcon(raw.icon) ? raw.icon : '/favicon.ico',
        cf: [],
        v6: [],
      };
      if (!svc.name) svc.name = key;

      let cf = raw.cf;
      if (cf == null) {
        cf = [];
        if (raw.cf1) cf.push(raw.cf1);
        if (raw.cf2) cf.push(raw.cf2);
      }
      if (typeof cf === 'string') cf = cf ? [cf] : [];
      if (!Array.isArray(cf)) {
        errors.push(`${key}.cf 必须是数组`);
      } else {
        for (const value of cf) {
          if (value == null || value === '') continue;
          if (!isHttpsUrl(value)) {
            errors.push(`${key}.cf 含非法 URL`);
            continue;
          }
          if (svc.cf.length < 6) svc.cf.push(cleanUrl(value));
        }
        if (cf.length > 6) errors.push(`${key}.cf 最多 6 个`);
      }

      let v6 = raw.v6;
      if (typeof v6 === 'string') v6 = v6 ? [v6] : [];
      if (v6 != null) {
        if (!Array.isArray(v6)) {
          errors.push(`${key}.v6 必须是数组`);
        } else {
          for (const value of v6) {
            if (value == null || value === '') continue;
            if (!isHttpsUrl(value)) {
              errors.push(`${key}.v6 含非法 URL`);
              continue;
            }
            if (svc.v6.length < 3) svc.v6.push(cleanUrl(value));
          }
          if (v6.length > 3) errors.push(`${key}.v6 最多 3 个`);
        }
      }
      config.services[key] = svc;
    }
  }

  const aliases = input.aliases;
  if (aliases != null) {
    if (typeof aliases !== 'object' || Array.isArray(aliases)) {
      errors.push('aliases 必须是一个对象');
    } else {
      for (const [alias, target] of Object.entries(aliases)) {
        if (!LABEL_RE.test(alias)) {
          errors.push(`别名 "${alias}" 不合法`);
          continue;
        }
        if (RESERVED_LABELS.has(alias)) {
          errors.push(`别名 "${alias}" 是保留名`);
          continue;
        }
        if (config.services[alias]) {
          errors.push(`别名 "${alias}" 与服务键冲突`);
          continue;
        }
        if (typeof target !== 'string' || !config.services[target]) {
          errors.push(`别名 "${alias}" 指向不存在的服务`);
          continue;
        }
        config.aliases[alias] = target;
      }
    }
  }

  if (errors.length) return { config: null, errors };
  return { config, errors: [] };
}

async function readConfig(env) {
  if (env.CONFIG) {
    try {
      const raw = await env.CONFIG.get(CONFIG_KEY, { type: 'json' });
      if (raw) {
        const checked = validateConfig(raw);
        if (checked.config) {
          checked.config.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
          return { config: checked.config, source: 'kv' };
        }
        return {
          config: clone(DEFAULT_CONFIG),
          source: 'default',
          warning: 'KV 里的配置无效，已回退到内置默认配置：' + checked.errors.join('；'),
        };
      }
    } catch {
      return { config: clone(DEFAULT_CONFIG), source: 'default', warning: 'KV 读取失败，已回退到内置默认配置' };
    }
  }
  return {
    config: clone(DEFAULT_CONFIG),
    source: 'default',
    warning: env.CONFIG ? undefined : 'Worker 没有绑定 KV 命名空间 CONFIG，当前使用内置默认配置',
  };
}

async function loadConfig(env) {
  return (await readConfig(env)).config;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.toLowerCase() === ADMIN_HOST) {
      return handleAdmin(request, url, env);
    }
    const config = await loadConfig(env);
    return handleRouter(request, url, config);
  },
};

async function handleRouter(request, url, config) {
  const host = url.hostname.toLowerCase();
  const label = host.split('.')[0];
  const serviceKey = config.services[label] ? label : config.aliases[label];
  const service = serviceKey ? config.services[serviceKey] : null;

  if (!service) {
    const isIndex = label === 'go' || label === 'index' || host === config.settings.baseDomain;
    return indexPage(config, isIndex ? 200 : 404);
  }

  if (!service.enabled) return maintenancePage(config, service);

  const u = new URL(url);
  u.searchParams.delete('to');
  const path = u.pathname + u.search;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const fallback = service.cf[0] || service.v6[0];
    if (!fallback) return maintenancePage(config, service);
    return redirect(request, path, fallback);
  }

  const to = url.searchParams.get('to');
  if (to) {
    const cfMatch = /^cf([1-9]\d*)$/.exec(to);
    if (cfMatch) {
      const index = Number(cfMatch[1]) - 1;
      if (service.cf[index]) return redirect(request, path, service.cf[index]);
    }
    if (to === 'v6' && service.v6[0]) return redirect(request, path, service.v6[0]);
    if (to === 'v6b' && service.v6[1]) return redirect(request, path, service.v6[1]);
    if (to === 'v6c' && service.v6[2]) return redirect(request, path, service.v6[2]);
  }

  return probePage(config, service, path);
}

function redirect(request, path, base) {
  const isNavigation = request.method === 'GET' || request.method === 'HEAD';
  return new Response(null, {
    status: isNavigation ? 302 : 307,
    headers: {
      location: base + path,
      'cache-control': 'no-store',
    },
  });
}

function indexPage(config, status) {
  const base = config.settings.baseDomain;
  const items = Object.keys(config.services).sort().map((key) => {
    const service = config.services[key];
    const labels = [key].concat(
      Object.keys(config.aliases).filter((alias) => config.aliases[alias] === key),
    );
    const links = labels.map((label) => (
      `<a href="https://${H(label)}.${H(base)}/">${H(label)}.${H(base)}</a>`
    )).join('');
    const disabled = service.enabled ? '' : ' <em>（维护中）</em>';
    return `<li><div class="n">${H(service.name || key)}${disabled}</div><div class="l">${links}</div></li>`;
  }).join('');

  return new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status === 200 ? '服务入口' : '未知服务'} · ${H(base)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:3rem auto;padding:0 1.2rem}
h1{font-size:1.3rem}p{opacity:.7}ul{list-style:none;padding:0}li{padding:.9rem 0;border-bottom:1px solid #8883}
.n{font-weight:600}.l{font-size:.85rem;opacity:.8;word-break:break-all}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
em{font-style:normal;font-size:.75rem;opacity:.6;margin-left:.4rem}
</style>
<h1>${status === 200 ? '选择服务' : '未知服务'}</h1>
<p>进入后会按当前网络自动选择最快的线路。</p>
<ul>${items || '<li>还没有配置服务</li>'}</ul>
</html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function maintenancePage(config, service) {
  return new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>维护中 · ${H(service.name)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:560px;margin:4rem auto;padding:0 1.2rem;text-align:center}
h1{font-size:1.2rem}p{opacity:.7}a{color:inherit}
</style>
<h1>${H(service.name)} 正在维护</h1>
<p>稍后再试，或返回 <a href="https://go.${H(config.settings.baseDomain)}/">服务入口</a>。</p>
</html>`, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function probePage(config, service, path) {
  const cf = service.cf.filter(Boolean);
  const v6 = service.v6.filter(Boolean);
  const settings = config.settings;
  const baseDomain = config.settings.baseDomain;
  const icon = service.icon || '/favicon.ico';
  const firstBase = cf[0] || v6[0] || '';
  const logoUrl = icon.indexOf('https://') === 0 ? icon : (firstBase ? firstBase + icon : '');
  const initial = Array.from((service.name || '入').trim())[0] || '入';
  const fallback = cf[0] || v6[0] || `https://go.${baseDomain}/`;
  const noscriptHref = fallback + path;

  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在进入 · ${H(service.name)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f7fc;--bg2:#e8f0ff;--card:#ffffffee;--text:#0b1222;--muted:#475569;--line:#dbe4f0;--accent:#2f6fed;--accent2:#6d28d9;--ok:#0d9f6e;--bad:#dc2626;--chip:#f4f7fd;--shadow:0 24px 70px #0f172a26}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e15;--bg2:#101622;--card:#141a24e6;--text:#e8eef8;--muted:#a8b6c9;--line:#263246;--chip:#1a2230;--shadow:0 24px 80px #0009}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:2rem 1rem;background:radial-gradient(1200px 800px at 10% 0%,var(--bg2),var(--bg) 60%);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow-x:hidden}
.bg{position:fixed;inset:-25%;z-index:-1;filter:blur(70px);opacity:.65;pointer-events:none}
.bg:before,.bg:after{content:"";position:absolute;width:48vmax;height:48vmax;border-radius:50%}
.bg:before{left:6%;top:4%;background:radial-gradient(circle at 35% 35%,#4c8dffcc,#7c3aed00 70%);animation:drift 20s ease-in-out infinite alternate}
.bg:after{right:2%;bottom:0%;background:radial-gradient(circle at 60% 60%,#22d3eeaa,#22d3ee00 70%);animation:drift 26s ease-in-out infinite alternate-reverse}
.card{width:min(440px,calc(100vw - 2rem));padding:1.6rem 1.5rem 1.25rem;border:1px solid var(--line);border-radius:24px;background:var(--card);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:var(--shadow);text-align:center;animation:pop .45s cubic-bezier(.2,.9,.3,1.15) both;transition:opacity .18s ease,transform .18s ease}
.card.leaving{opacity:0;transform:translateY(-8px) scale(.985)}
.logo{width:60px;height:60px;margin:0 auto .9rem;border-radius:18px;display:grid;place-items:center;overflow:hidden;background:linear-gradient(145deg,var(--accent),var(--accent2));color:#fff;font-size:1.4rem;font-weight:700;box-shadow:0 12px 28px #2f6fed40}
.logo img{width:100%;height:100%;object-fit:cover;display:block}
.logo .letter{display:none}
.logo.fallback img{display:none}
.logo.fallback .letter{display:block}
h1{margin:0;font-size:1.25rem;letter-spacing:.01em}
.sub{margin:.3rem 0 1.05rem;color:var(--muted);font-size:.82rem}
.bar{height:4px;border-radius:999px;background:var(--chip);overflow:hidden;margin:0 0 1.05rem}
.bar span{display:block;height:100%;width:38%;border-radius:999px;background:linear-gradient(90deg,#00000000,var(--accent),var(--accent2),#00000000);animation:slide 1.15s linear infinite}
.routes{display:flex;flex-direction:column;gap:.42rem;text-align:left;margin-bottom:.9rem}
.route{display:flex;align-items:center;gap:.5rem;padding:.48rem .6rem;border:1px solid var(--line);border-radius:12px;background:var(--chip);font-size:.78rem;color:var(--muted);transition:border-color .2s,background .2s,color .2s,opacity .2s}
.route .dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.45;flex:0 0 auto}
.route .label{font-weight:600;color:var(--text);min-width:4.3rem;white-space:nowrap}
.route .url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.7rem;opacity:.85}
.route .ms{font-variant-numeric:tabular-nums;font-size:.72rem;min-width:3.1rem;text-align:right}
.route.testing{color:var(--accent);border-color:var(--accent)}
.route.testing .dot{opacity:1;animation:pulse 1s ease-in-out infinite}
.route.ok{color:var(--ok);border-color:var(--ok)}
.route.ok .dot{opacity:1}
.route.bad{color:var(--bad);border-color:var(--bad);opacity:.75}
.route.bad .dot{opacity:1}
.route.dim{opacity:.7}
.route.chosen{border-color:var(--accent);background:var(--chip);box-shadow:0 0 0 1px var(--accent) inset}
.route.chosen .label{color:var(--accent)}
.route.chosen .ms{color:var(--accent);font-weight:600}
#status{margin:0 0 .6rem;font-size:.8rem;color:var(--muted);min-height:1.35em}
.links{display:none;text-align:left;margin:.2rem 0 .4rem}
.links.show{display:block}
.links p{margin:.1rem 0 .45rem;font-size:.76rem;color:var(--bad)}
.links a{display:flex;justify-content:space-between;gap:.8rem;padding:.5rem .6rem;margin-bottom:.32rem;border:1px solid var(--line);border-radius:10px;background:var(--chip);color:var(--text);text-decoration:none;font-size:.76rem}
.links a span:last-child{color:var(--muted);font-size:.7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.links a:hover{border-color:var(--accent)}
.retry{width:100%;margin-top:.2rem;padding:.5rem .6rem;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--muted);font:inherit;font-size:.76rem;cursor:pointer}
.retry:hover{border-color:var(--accent);color:var(--accent)}
.foot{margin-top:.9rem;font-size:.66rem;color:var(--muted);opacity:.55;letter-spacing:.08em}
.noscript{margin-top:.6rem;font-size:.76rem;color:var(--muted)}
@keyframes slide{from{transform:translateX(-120%)}to{transform:translateX(320%)}}
@keyframes pulse{0%,100%{transform:scale(.8);opacity:.45}50%{transform:scale(1.2);opacity:1}}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@keyframes drift{from{transform:translate3d(-2%,-1%,0) scale(1)}to{transform:translate3d(3%,2%,0) scale(1.07)}}
@media (max-width:420px){.card{padding:1.35rem 1.1rem 1.1rem;border-radius:20px}.route .label{min-width:3.6rem}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
</style>
</head>
<body>
<div class="bg"></div>
<main class="card" id="card">
  <div class="logo${logoUrl ? '' : ' fallback'}" id="logo">
    ${logoUrl ? `<img id="logoImg" src="${H(logoUrl)}" alt="" referrerpolicy="no-referrer" decoding="async">` : ''}
    <span class="letter">${H(initial)}</span>
  </div>
  <h1>${H(service.name)}</h1>
  <p class="sub">正在选择最快线路</p>
  <div class="bar"><span></span></div>
  <div class="routes" id="routes" aria-label="线路检测状态"></div>
  <p id="status" role="status" aria-live="polite">正在检测…</p>
  <div class="links" id="links">
    <p>自动选择失败，手动进入：</p>
    <div id="link-list"></div>
    <button class="retry" id="retry" type="button">重试</button>
  </div>
  <div class="foot">${H(baseDomain)} · 智能入口</div>
  <noscript><div class="noscript">需要 JavaScript 才能自动选路；<a href="${H(noscriptHref)}">直接进入</a></div></noscript>
</main>
<script>
(function(){
var CF=${J(cf)}, V6=${J(v6)}, ICON=${J(icon)}, PATH=${J(path)}, DMS=${Number(settings.directTimeoutMs)}, CMS=${Number(settings.cfTimeoutMs)};
var PREVIEW=location.hash==='#preview';
var card=document.getElementById('card');
var statusEl=document.getElementById('status');
var routesEl=document.getElementById('routes');
var linksEl=document.getElementById('links');
var linkList=document.getElementById('link-list');
var logo=document.getElementById('logo');
var logoImg=document.getElementById('logoImg');
if(logoImg) logoImg.addEventListener('error',function(){logo.classList.add('fallback');});
function addRoute(label,base){
  var row=document.createElement('div');
  row.className='route testing';
  var dot=document.createElement('span'); dot.className='dot';
  var l=document.createElement('span'); l.className='label'; l.textContent=label;
  var u=document.createElement('span'); u.className='url'; u.textContent=base.replace('https://','');
  var ms=document.createElement('span'); ms.className='ms'; ms.textContent='…';
  row.appendChild(dot); row.appendChild(l); row.appendChild(u); row.appendChild(ms);
  routesEl.appendChild(row);
  return {el:row,label:label,base:base,ms:ms};
}
function updateChip(item,t){
  item.el.classList.remove('testing');
  if(t===Infinity){item.el.classList.add('bad');item.ms.textContent='失败';}
  else{item.el.classList.add('ok');item.ms.textContent=Math.round(t)+' ms';}
}
var cfItems=CF.map(function(u,i){return addRoute('CF '+(i+1),u);});
var v6Items=V6.map(function(u,i){return addRoute('IPv6 '+(i+1),u);});
function addLink(item){
  var a=document.createElement('a');
  a.href=item.base+PATH;
  a.target='_blank';
  a.rel='noopener';
  var l=document.createElement('span'); l.textContent=item.label;
  var u=document.createElement('span'); u.textContent=item.base.replace('https://','');
  a.appendChild(l); a.appendChild(u);
  linkList.appendChild(a);
}
cfItems.forEach(addLink); v6Items.forEach(addLink);
document.getElementById('retry').onclick=function(){location.reload();};
function probe(item,timeoutMs){
  return new Promise(function(resolve){
    var img=new Image();
    var t0=performance.now();
    var done=false;
    var timer=setTimeout(function(){finish(Infinity);},timeoutMs);
    function finish(t){
      if(done) return;
      done=true;
      clearTimeout(timer);
      img.onload=img.onerror=null;
      if(t===Infinity) img.src='';
      updateChip(item,t);
      resolve(t);
    }
    img.onload=function(){finish(performance.now()-t0);};
    img.onerror=function(){finish(Infinity);};
    var src=ICON.indexOf('https://')===0?ICON:item.base+ICON;
    img.src=src+(src.indexOf('?')>=0?'&':'?')+'t='+Date.now();
  });
}
function go(item){
  item.el.classList.add('chosen');
  Array.prototype.forEach.call(routesEl.querySelectorAll('.route'),function(r){if(r!==item.el)r.classList.add('dim');});
  if(PREVIEW){
    statusEl.textContent='已选择 '+item.label+'（预览模式，未跳转）';
    return;
  }
  statusEl.textContent='已选择 '+item.label+'，正在进入…';
  var wait=Math.max(0,420-performance.now());
  setTimeout(function(){
    card.classList.add('leaving');
    setTimeout(function(){location.replace(item.base+PATH);},180);
  },wait);
}
function fail(){
  statusEl.textContent='没有可用线路，请手动选择';
  linksEl.classList.add('show');
}
var cfReady=cfItems.length?Promise.all(cfItems.map(function(item){return probe(item,CMS).then(function(t){return {item:item,t:t};});})):Promise.resolve([]);
var v6MainP=v6Items.length?probe(v6Items[0],DMS):Promise.resolve(Infinity);
var v6RestP=v6Items.length>1?Promise.all(v6Items.slice(1).map(function(item){return probe(item,DMS).then(function(t){return {item:item,t:t};});})):Promise.resolve([]);
function fromCf(){
  if(!cfItems.length) return fail();
  statusEl.textContent='IPv6 直连不可用，正在比较 CF 线路…';
  return cfReady.then(function(rs){
    var ok=rs.filter(function(x){return x.t!==Infinity;}).sort(function(a,b){return a.t-b.t;});
    if(ok.length) return go(ok[0].item);
    fail();
  });
}
if(v6Items.length){
  statusEl.textContent='优先尝试 IPv6 直连…';
  v6MainP.then(function(t){
    if(t!==Infinity) return go(v6Items[0]);
    return v6RestP.then(function(rs){
      var ok=rs.filter(function(x){return x.t!==Infinity;});
      if(ok.length) return go(ok[0].item);
      return fromCf();
    });
  });
}else{
  fromCf();
}
})();
</script>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}
const LOGIN_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f1115,#1b2230);color:#e6e8ee;font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(380px,92vw);padding:2rem;border:1px solid #ffffff1a;border-radius:16px;background:#171a21ee;box-shadow:0 20px 60px #0008}
h1{margin:0 0 .3rem;font-size:1.25rem}
p{margin:.2rem 0 1.2rem;color:#9aa3b2;font-size:.9rem}
label{display:block;font-size:.8rem;color:#9aa3b2;margin-bottom:.4rem}
input{width:100%;padding:.7rem .8rem;border:1px solid #2a2f3a;border-radius:10px;background:#0f1115;color:inherit;font:inherit;outline:none}
input:focus{border-color:#4c8dff}
button{width:100%;margin-top:1rem;padding:.7rem .8rem;border:0;border-radius:10px;background:#4c8dff;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#3b7df0}
.err{margin-top:.8rem;color:#ff6b6b;font-size:.9rem}
.hint{margin-top:1.2rem;font-size:.75rem;color:#6b7280}
`;

function adminHtmlHeaders(nonce) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    'content-security-policy': "default-src 'none'; script-src 'nonce-" + nonce
      + "'; style-src 'nonce-" + nonce
      + "'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function loginPage(error, status = 200) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>路由管理 · 登录</title>
<style nonce="${nonce}">${LOGIN_CSS}</style>
<body>
<main class="card">
<h1>路由管理</h1>
<p>输入管理密码</p>
<form method="post" action="/login">
<label for="p">管理密码</label>
<input id="p" type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">登录</button>
</form>
${error ? `<div class="err">${H(error)}</div>` : ''}
<div class="hint">密码是 Worker 的 <code>ADMIN_PASSWORD</code> secret。</div>
</main>
</body>
</html>`, { status, headers: adminHtmlHeaders(nonce) });
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    if (trimmed.slice(0, index) === name) return trimmed.slice(index + 1);
  }
  return null;
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const left = enc.encode(String(a));
  const right = enc.encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

let sessionKeyCache = null;
async function sessionKey(env) {
  if (sessionKeyCache && sessionKeyCache.password === env.ADMIN_PASSWORD) {
    return sessionKeyCache.key;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode('router-admin-session|' + env.ADMIN_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  sessionKeyCache = { password: env.ADMIN_PASSWORD, key };
  return key;
}

async function signSession(env, data) {
  const key = await sessionKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(new Uint8Array(signature));
}

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const raw = getCookie(request, 'admin_session');
  if (!raw) return false;
  const index = raw.lastIndexOf('.');
  if (index < 0) return false;
  const exp = raw.slice(0, index);
  const sig = raw.slice(index + 1);
  const expires = Number(exp);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = await signSession(env, exp);
  return safeEqual(sig, expected);
}

const loginFailures = new Map();

function loginBlocked(ip) {
  const record = loginFailures.get(ip);
  if (!record) return false;
  if (record.reset < Date.now()) {
    loginFailures.delete(ip);
    return false;
  }
  return record.count >= MAX_LOGIN_FAILS;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let record = loginFailures.get(ip);
  if (!record || record.reset < now) record = { count: 0, reset: now + LOGIN_WINDOW_MS };
  record.count += 1;
  loginFailures.set(ip, record);
}

async function handleAdmin(request, url, env) {
  if (!env.ADMIN_PASSWORD) {
    return new Response('管理面板未配置 ADMIN_PASSWORD secret。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const path = url.pathname;

  if (path === '/favicon.ico') {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }

  if (path === '/login') {
    if (request.method === 'GET') {
      if (await isAuthed(request, env)) {
        return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
      }
      return loginPage('');
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (loginBlocked(ip)) return loginPage('尝试次数过多，请 10 分钟后再试', 429);

    let password = '';
    try {
      const form = await request.formData();
      password = String(form.get('password') || '');
    } catch {
      return loginPage('表单解析失败', 400);
    }
    if (!safeEqual(password, env.ADMIN_PASSWORD)) {
      recordLoginFailure(ip);
      await sleep(400);
      return loginPage('密码错误', 401);
    }

    loginFailures.delete(ip);
    const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
    const exp = String(expires);
    const sig = await signSession(env, exp);
    return new Response(null, {
      status: 302,
      headers: {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': `admin_session=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
      },
    });
  }

  if (path === '/logout' && request.method === 'POST') {
    return new Response(null, {
      status: 302,
      headers: {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': 'admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      },
    });
  }

  if (path === '/api/config') {
    return handleApiConfig(request, env, url);
  }

  if (path === '/api/icon-scan') {
    return handleIconScan(request, env);
  }

  if (path === '/' || path === '/index.html') {
    if (request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
    if (!(await isAuthed(request, env))) return loginPage('');
    return panelPage();
  }

  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleApiConfig(request, env, url) {
  if (!(await isAuthed(request, env))) return json({ ok: false, error: '未登录' }, 401);

  if (request.method === 'GET') {
    const result = await readConfig(env);
    return json({ ok: true, ...result });
  }

  if (request.method === 'PUT') {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      return json({ ok: false, error: 'Content-Type 必须是 application/json' }, 415);
    }
    if (!env.CONFIG) return json({ ok: false, error: 'Worker 没有绑定 KV 命名空间 CONFIG' }, 500);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'JSON 格式错误' }, 400);
    }

    const checked = validateConfig(body);
    if (checked.errors.length) return json({ ok: false, errors: checked.errors }, 400);

    checked.config.updatedAt = new Date().toISOString();
    try {
      await env.CONFIG.put(CONFIG_KEY, JSON.stringify(checked.config));
    } catch {
      return json({ ok: false, error: 'KV 写入失败' }, 500);
    }
    return json({ ok: true, config: checked.config });
  }

  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}

async function handleIconScan(request, env) {
  if (!(await isAuthed(request, env))) return json({ ok: false, error: '未登录' }, 401);
  if (request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return json({ ok: false, error: 'Content-Type 必须是 application/json' }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'JSON 格式错误' }, 400);
  }

  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .slice(0, 6)
    .filter(isHttpsUrl)
    .map(cleanUrl);
  if (!urls.length) return json({ ok: false, error: '没有合法的 https 地址' }, 400);

  const tried = [];
  for (const url of urls) {
    try {
      const result = await scanIconForUrl(url);
      if (result) {
        return json({
          ok: true,
          icon: result.icon,
          source: url,
          candidates: result.candidates,
          tried,
        });
      }
      tried.push({ url, error: '未发现图标' });
    } catch (e) {
      tried.push({ url, error: String((e && e.message) || e) });
    }
  }
  return json({ ok: false, error: '没有扫描到图标', tried }, 404);
}

async function scanIconForUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; service-router icon-scan)' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return null;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/html')) return null;

  const html = (await response.text()).slice(0, 300000);
  const base = response.url || url;
  const baseOrigin = new URL(base).origin;
  const candidates = [];
  const seen = new Set();

  const linkRe = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    const tag = match[0];
    const rel = (getAttr(tag, 'rel') || '').toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = getAttr(tag, 'href');
    if (!href) continue;
    try {
      const absolute = new URL(decodeEntities(href), base);
      if (absolute.protocol !== 'https:') continue;
      const isSameOrigin = absolute.origin === baseOrigin;
      const value = isSameOrigin ? absolute.pathname + absolute.search : absolute.href;
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push({ icon: value, rel, absolute: !isSameOrigin });
    } catch {
      // ignore malformed href
    }
  }

  const common = ['/favicon.ico', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'];
  for (const path of common) {
    if (seen.has(path)) continue;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      let iconResponse;
      try {
        iconResponse = await fetch(baseOrigin + path, {
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; service-router icon-scan)' },
        });
      } finally {
        clearTimeout(t);
      }
      const iconType = (iconResponse.headers.get('content-type') || '').toLowerCase();
      if (iconResponse.ok && iconType.startsWith('image/')) {
        candidates.push({ icon: path, rel: 'common', absolute: false });
        seen.add(path);
        break;
      }
    } catch {
      // ignore common-path probe errors
    }
  }

  if (!candidates.length) return null;
  return { icon: candidates[0].icon, candidates };
}

function getAttr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const match = tag.match(re);
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

const PANEL_CSS = String.raw`
:root{color-scheme:light dark;--bg:#f6f7fb;--panel:#fff;--line:#e5e7ee;--text:#1f2430;--muted:#6b7280;--accent:#3b82f6;--accent-2:#2563eb;--ok:#0f9f6e;--bad:#dc2626;--chip:#eef2ff;--chip-text:#3730a3;--shadow:0 1px 2px #0001,0 8px 24px #0000000d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--muted:#9aa3b2;--accent:#4c8dff;--accent-2:#6aa1ff;--ok:#37c871;--bad:#ff5c5c;--chip:#1e2633;--chip-text:#9cc0ff;--shadow:0 1px 2px #0006,0 8px 24px #0009}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.top{position:sticky;top:0;z-index:10;display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.9rem 1.2rem;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}
.brand h1{margin:0;font-size:1.05rem}.brand p{margin:.1rem 0 0;color:var(--muted);font-size:.78rem}
.top-actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.wrap{max-width:1180px;margin:1.4rem auto 4rem;padding:0 1.2rem}
.panel{margin:1.2rem 0;padding:1.1rem;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:var(--shadow)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.8rem}
.panel h2{margin:0;font-size:1rem}.panel h3{margin:1rem 0 .6rem;font-size:.9rem;color:var(--muted)}
.hint{margin:.3rem 0 .8rem;color:var(--muted);font-size:.8rem}
.cards{display:grid;gap:1rem}
.card{padding:1rem;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--panel) 92%,var(--bg))}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.card-tools{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.card-body{margin-top:.8rem}
.icon-field{margin-bottom:.8rem}
.icon-row{display:flex;align-items:center;gap:.5rem}
.icon-row input{flex:1}
.hint.small{font-size:.72rem;margin-top:.1rem}
.card-head h2{margin:0;font-size:1rem}
.key{display:inline-block;margin-left:.5rem;padding:.05rem .4rem;border-radius:6px;background:var(--chip);color:var(--chip-text);font-size:.75rem}
.switch{display:flex;align-items:center;gap:.4rem;color:var(--muted);font-size:.8rem;white-space:nowrap}
.entries{display:flex;gap:.4rem;flex-wrap:wrap;margin:.6rem 0 .8rem}
.chip{display:inline-block;padding:.15rem .5rem;border-radius:999px;background:var(--chip);color:var(--chip-text);font-size:.75rem;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.7rem 1rem}
.field{display:flex;flex-direction:column;gap:.25rem;font-size:.78rem;color:var(--muted)}
.field input,.field select,.add-form input,.alias-row input,.alias-row select,textarea{width:100%;padding:.5rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:.85rem;outline:none}
.field input:focus,.add-form input:focus,textarea:focus,.alias-row input:focus{border-color:var(--accent)}
.v6-box{margin-top:.8rem;padding:.7rem;border:1px dashed var(--line);border-radius:10px}
.v6-box .label{font-size:.78rem;color:var(--muted);margin-bottom:.4rem}
.v6-row{display:flex;gap:.5rem;align-items:center;margin-bottom:.4rem}
.v6-row input{flex:1}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.card-actions{margin-top:.8rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.3rem;padding:.42rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);font:inherit;font-size:.8rem;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent-2);color:#fff}
.btn.ghost{background:transparent}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
.btn.small{padding:.3rem .55rem;font-size:.75rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
.test-results{margin-top:.8rem;display:flex;flex-direction:column;gap:.3rem}
.result{display:flex;gap:.6rem;align-items:center;font-size:.8rem;padding:.3rem .5rem;border-radius:8px;background:var(--bg)}
.result.ok{border-left:3px solid var(--ok)}.result.bad{border-left:3px solid var(--bad);color:var(--muted)}
.result .r-label{font-weight:600;min-width:4rem}
.result .r-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.result .r-ms{font-variant-numeric:tabular-nums}
.winner{margin-top:.4rem;font-size:.8rem;color:var(--ok);word-break:break-all}
.winner.bad{color:var(--bad)}
.test-summary{margin:.2rem 0 1rem;padding:.7rem;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.summary-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.5rem;font-weight:600;font-size:.85rem}
.summary-list{display:flex;flex-direction:column;gap:.35rem}
.summary-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2.2fr) minmax(0,1.4fr);gap:.5rem;align-items:center;padding:.35rem .45rem;border-radius:8px;background:var(--panel);font-size:.78rem}
.summary-svc strong{display:block}.summary-svc code{font-size:.7rem;color:var(--muted)}
.summary-routes{display:flex;gap:.3rem;flex-wrap:wrap}
.summary-chip{padding:.05rem .35rem;border-radius:999px;font-size:.72rem;background:var(--chip);color:var(--chip-text)}
.summary-chip.ok{color:var(--ok)}.summary-chip.bad{color:var(--bad);opacity:.8}
.summary-win{color:var(--ok);word-break:break-all}.summary-win.bad{color:var(--bad)}
@media(max-width:720px){.summary-row{grid-template-columns:1fr}}
.add-form{margin-top:1rem;padding:.9rem;border:1px dashed var(--line);border-radius:10px}
.alias-list{display:flex;flex-direction:column;gap:.45rem}
.alias-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.alias-row code{padding:.05rem .35rem;border-radius:5px;background:var(--chip);color:var(--chip-text);font-size:.78rem}
.alias-row .arrow{color:var(--muted)}
textarea{min-height:220px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;line-height:1.5}
.banner{margin:1rem 0;padding:.7rem .9rem;border:1px solid #f59e0b55;border-radius:10px;background:#f59e0b1a;color:#92400e;font-size:.82rem}
@media (prefers-color-scheme:dark){.banner{color:#fbbf24}}
.toast{position:fixed;left:50%;bottom:1.4rem;transform:translateX(-50%);padding:.6rem 1rem;border-radius:10px;background:#1f2937;color:#fff;font-size:.85rem;box-shadow:0 10px 30px #0006;z-index:50}
.toast.bad{background:#b91c1c}
.toast[hidden]{display:none}
.inline{display:inline}
`;

const PANEL_JS = String.raw`
(function(){
'use strict';
var state={config:null,source:null,warning:null,dirty:false};
var collapsed=new Set();
try{(JSON.parse(localStorage.getItem('router-collapsed')||'[]')||[]).forEach(function(k){collapsed.add(k);});}catch(e){}
function saveCollapsed(){try{localStorage.setItem('router-collapsed',JSON.stringify(Array.from(collapsed)));}catch(e){}}
function normalizeConfigClient(cfg){
  if(!cfg||typeof cfg!=='object') return cfg;
  cfg.settings=Object.assign({baseDomain:'example.net',directTimeoutMs:1500,cfTimeoutMs:2800},cfg.settings||{});
  cfg.aliases=cfg.aliases||{};
  cfg.services=cfg.services||{};
  Object.keys(cfg.services).forEach(function(k){
    var s=cfg.services[k]||{};
    if(!Array.isArray(s.cf)) s.cf=[s.cf1,s.cf2].filter(Boolean);
    if(!Array.isArray(s.v6)) s.v6=s.v6?[s.v6]:[];
    s.cf=s.cf.filter(Boolean);
    s.v6=s.v6.filter(Boolean);
    if(!s.icon) s.icon='/favicon.ico';
    if(s.enabled==null) s.enabled=true;
    cfg.services[k]=s;
  });
  return cfg;
}
var $=function(s,r){return (r||document).querySelector(s);};
var toastTimer=null;
function el(tag,attrs){
  var n=document.createElement(tag);
  if(attrs){Object.keys(attrs).forEach(function(k){
    var v=attrs[k];
    if(v==null||v===false) return;
    if(k==='class') n.className=v;
    else if(k==='text') n.textContent=v;
    else if(k==='value') n.value=v;
    else if(k==='checked') n.checked=!!v;
    else if(k==='disabled') n.disabled=!!v;
    else if(k.indexOf('on')===0&&typeof v==='function') n.addEventListener(k.slice(2).toLowerCase(),v);
    else n.setAttribute(k,v===true?'':v);
  });}
  for(var i=2;i<arguments.length;i++){
    var kid=arguments[i];
    if(kid==null) continue;
    n.appendChild(kid instanceof Node?kid:document.createTextNode(String(kid)));
  }
  return n;
}
function inputEl(value,onInput,attrs){
  attrs=attrs||{};
  var base={type:'text',value:value==null?'':value};
  Object.keys(attrs).forEach(function(k){base[k]=attrs[k];});
  var i=el('input',base);
  if(onInput) i.addEventListener('input',function(){onInput(i.value);});
  return i;
}
function field(label,input){return el('label',{class:'field'},el('span',{text:label}),input);}
function entriesFor(key){
  var base=state.config.settings.baseDomain;
  var labels=[key];
  Object.keys(state.config.aliases).forEach(function(a){if(state.config.aliases[a]===key)labels.push(a);});
  return labels.map(function(l){return l+'.'+base;});
}
function markDirty(){state.dirty=true;updateSave();updateMeta();}
function updateSave(){var b=$('#saveBtn');b.disabled=!state.dirty;if(!b.disabled)b.textContent='保存';}
function updateMeta(){
  var m=$('#meta');
  var source=state.source==='kv'?'KV':'内置默认';
  var ts=state.config&&state.config.updatedAt?' · 更新于 '+new Date(state.config.updatedAt).toLocaleString():'';
  m.textContent=state.dirty?'有未保存的修改':('来源：'+source+ts);
}
function toast(msg,bad){
  var t=$('#toast');
  t.textContent=msg;
  t.className='toast'+(bad?' bad':'');
  t.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.hidden=true;},4200);
}
async function api(path,opts){
  opts=opts||{};
  var headers=Object.assign({},opts.headers||{});
  if(opts.body) headers['content-type']='application/json';
  var r=await fetch(path,Object.assign({},opts,{headers:headers}));
  if(r.status===401){location.href='/';throw new Error('未登录');}
  var data=null;
  try{data=await r.json();}catch(e){}
  if(!r.ok||!data||data.ok===false){throw data||{error:'请求失败 ('+r.status+')'};}
  return data;
}
async function load(){
  try{
    var data=await api('/api/config');
    state.config=normalizeConfigClient(data.config);
    state.source=data.source;
    state.warning=data.warning||null;
    state.dirty=false;
    render();
  }catch(e){
    toast(e.error||'加载失败',true);
  }
}
async function save(){
  var btn=$('#saveBtn');
  btn.disabled=true;
  btn.textContent='保存中…';
  try{
    var data=await api('/api/config',{method:'PUT',body:JSON.stringify(state.config)});
    state.config=data.config;
    state.source='kv';
    state.warning=null;
    state.dirty=false;
    render();
    toast('已保存。KV 生效可能延迟约 1 分钟。');
  }catch(e){
    if(e.errors&&e.errors.length) toast('保存失败：'+e.errors.slice(0,3).join('；'),true);
    else toast('保存失败：'+(e.error||'未知错误'),true);
    btn.disabled=false;
    btn.textContent='保存';
  }
}
function probe(base,icon,timeoutMs){
  return new Promise(function(resolve){
    var img=new Image();
    var t0=performance.now();
    var done=false;
    var timer=setTimeout(function(){finish(Infinity);},timeoutMs);
    function finish(t){
      if(done) return;
      done=true;
      clearTimeout(timer);
      img.onload=img.onerror=null;
      if(t===Infinity) img.src='';
      resolve(t);
    }
    img.onload=function(){finish(performance.now()-t0);};
    img.onerror=function(){finish(Infinity);};
    var src=icon.indexOf('https://')===0?icon:base+icon;
    img.src=src+(src.indexOf('?')>=0?'&':'?')+'t='+Date.now();
  });
}
async function testService(key,card){
  var svc=state.config.services[key];
  var routes=[];
  (svc.cf||[]).forEach(function(u,i){if(u)routes.push({type:'cf',label:'CF'+(i+1),url:u});});
  (svc.v6||[]).forEach(function(u,i){if(u)routes.push({type:'v6',label:'直连'+(i+1),url:u});});
  var box=card.querySelector('.test-results');
  if(!routes.length){box.textContent='没有配置线路';return;}
  box.textContent='测试中…';
  var s=state.config.settings;
  var results=await Promise.all(routes.map(function(r){
    var timeout=r.type==='cf'?s.cfTimeoutMs:s.directTimeoutMs;
    return probe(r.url,svc.icon,timeout).then(function(t){return {r:r,t:t};});
  }));
  box.textContent='';
  results.forEach(function(x){
    box.appendChild(el('div',{class:'result '+(x.t===Infinity?'bad':'ok')},
      el('span',{class:'r-label',text:x.r.label}),
      el('span',{class:'r-url',text:x.r.url}),
      el('span',{class:'r-ms',text:x.t===Infinity?'失败':Math.round(x.t)+' ms'})
    ));
  });
  var v6ok=results.filter(function(x){return x.r.type==='v6'&&x.t!==Infinity;});
  var winner=v6ok.length?v6ok[0]:results.filter(function(x){return x.r.type==='cf'&&x.t!==Infinity;}).sort(function(a,b){return a.t-b.t;})[0];
  if(winner) box.appendChild(el('div',{class:'winner',text:'当前会选：'+winner.r.label+' · '+winner.r.url}));
  else box.appendChild(el('div',{class:'winner bad',text:'所有线路都不可用'}));
  return {key:key,svc:svc,results:results,winner:winner||null};
}
async function runPool(items,limit,fn){
  var index=0;
  async function worker(){
    while(index<items.length){
      var item=items[index++];
      await fn(item);
    }
  }
  var workers=[];
  for(var i=0;i<limit;i++) workers.push(worker());
  await Promise.all(workers);
}
var testingAll=false;
async function testAll(btn){
  if(testingAll) return;
  var keys=Object.keys(state.config.services).sort();
  if(!keys.length) return toast('还没有服务',true);
  testingAll=true;
  btn=btn||$('#testAllBtn');
  if(btn){btn.disabled=true;btn.textContent='测试中…';}
  var summary=$('#test-summary');
  var list=$('#summary-list');
  if(summary&&list){
    summary.hidden=false;
    list.textContent='';
  }
  var rows={};
  keys.forEach(function(k){
    var svc=state.config.services[k];
    var row=el('div',{class:'summary-row'},
      el('div',{class:'summary-svc'},el('strong',{text:svc.name||k}),el('code',{text:k})),
      el('div',{class:'summary-routes',text:'测试中…'}),
      el('div',{class:'summary-win',text:''})
    );
    rows[k]=row;
    if(list) list.appendChild(row);
  });
  try{
    await runPool(keys,2,async function(k){
      var card=document.querySelector('[data-key="'+k+'"]');
      var res;
      try{
        res=await testService(k,card);
      }catch(e){
        res={key:k,svc:state.config.services[k],results:[],winner:null,error:String(e)};
      }
      var row=rows[k];
      if(!row) return;
      var routes=row.querySelector('.summary-routes');
      var win=row.querySelector('.summary-win');
      routes.textContent='';
      if(res.error){
        routes.appendChild(el('span',{class:'summary-chip bad',text:'测试失败'}));
        win.className='summary-win bad';
        win.textContent=res.error;
        return;
      }
      res.results.forEach(function(x){
        routes.appendChild(el('span',{class:'summary-chip '+(x.t===Infinity?'bad':'ok')},x.r.label+' '+(x.t===Infinity?'失败':Math.round(x.t)+'ms')));
      });
      if(res.winner){
        win.className='summary-win';
        win.textContent='→ '+res.winner.r.label+' · '+res.winner.r.url;
      }else{
        win.className='summary-win bad';
        win.textContent='全部失败';
      }
    });
    toast('测试完成');
  }finally{
    testingAll=false;
    if(btn){btn.disabled=false;btn.textContent='测试全部';}
  }
}
function setAllCollapsed(value){
  Object.keys(state.config.services).forEach(function(k){
    if(value) collapsed.add(k); else collapsed.delete(k);
    var card=document.querySelector('[data-key="'+k+'"]');
    if(card){
      var body=card.querySelector('.card-body');
      var btn=card.querySelector('.collapse-btn');
      if(body) body.hidden=value;
      if(btn) btn.textContent=value?'展开':'收起';
    }
  });
  saveCollapsed();
}
async function scanIcon(svc,input,btn){
  var urls=[].concat(svc.cf||[],svc.v6||[]).filter(Boolean);
  if(!urls.length) return toast('先填至少一条线路地址',true);
  btn.disabled=true;
  btn.textContent='扫描中…';
  try{
    var data=await api('/api/icon-scan',{method:'POST',body:JSON.stringify({urls:urls})});
    svc.icon=data.icon;
    input.value=data.icon;
    markDirty();
    toast('已填入 '+data.icon+'（来自 '+data.source+'）');
  }catch(e){
    toast('没扫到：'+(e.error||'未知错误'),true);
  }finally{
    btn.disabled=false;
    btn.textContent='自动探测';
  }
}
function serviceCard(key){
  var svc=state.config.services[key];
  var base=state.config.settings.baseDomain;
  var card=el('article',{class:'card','data-key':key});
  var nameH=el('h2',{text:svc.name||key});
  var body=el('div',{class:'card-body'});
  var toggle=el('button',{class:'btn small collapse-btn',onclick:function(){
    if(collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    saveCollapsed();
    body.hidden=collapsed.has(key);
    toggle.textContent=collapsed.has(key)?'展开':'收起';
  }},collapsed.has(key)?'展开':'收起');
  card.appendChild(el('div',{class:'card-head'},
    el('div',{},nameH,el('code',{class:'key',text:key})),
    el('div',{class:'card-tools'},
      toggle,
      el('label',{class:'switch'},el('input',{type:'checkbox',checked:svc.enabled!==false,onchange:function(e){svc.enabled=e.target.checked;markDirty();}}),'启用')
    )
  ));
  var entries=el('div',{class:'entries'});
  entriesFor(key).forEach(function(host){
    entries.appendChild(el('a',{class:'chip',href:'https://'+host+'/',target:'_blank',rel:'noopener',text:host}));
  });
  card.appendChild(entries);

  var iconInput=inputEl(svc.icon,function(v){svc.icon=v.trim();markDirty();});
  var scanBtn=el('button',{class:'btn small',onclick:function(){scanIcon(svc,iconInput,scanBtn);}},'自动探测');
  body.appendChild(el('div',{class:'field icon-field'},
    el('span',{text:'图标路径'}),
    el('div',{class:'icon-row'},iconInput,scanBtn),
    el('div',{class:'hint small',text:'不知道填什么就点自动探测；也可以手填 / 路径或完整 https 图标 URL。'})
  ));

  var grid=el('div',{class:'grid'});
  grid.appendChild(field('显示名',inputEl(svc.name,function(v){svc.name=v;nameH.textContent=v||key;markDirty();})));
  body.appendChild(grid);

  var cfBox=el('div',{class:'v6-box'},el('div',{class:'label',text:'CF 优选线路（全部并行探测，选最快）'}));
  (svc.cf||[]).forEach(function(u,i){
    cfBox.appendChild(el('div',{class:'v6-row'},
      inputEl(u,function(v){svc.cf[i]=v.trim();markDirty();},{placeholder:'https://...'}),
      el('button',{class:'btn small danger',onclick:function(){svc.cf.splice(i,1);markDirty();render();}},'移除')
    ));
  });
  cfBox.appendChild(el('button',{class:'btn small',onclick:function(){svc.cf.push('');markDirty();render();}},'+ 添加 CF'));
  body.appendChild(cfBox);

  var v6box=el('div',{class:'v6-box'},el('div',{class:'label',text:'IPv6 直连（按顺序优先）'}));
  (svc.v6||[]).forEach(function(u,i){
    v6box.appendChild(el('div',{class:'v6-row'},
      inputEl(u,function(v){svc.v6[i]=v.trim();markDirty();},{placeholder:'https://...'}),
      el('button',{class:'btn small danger',onclick:function(){svc.v6.splice(i,1);markDirty();render();}},'移除')
    ));
  });
  v6box.appendChild(el('button',{class:'btn small',onclick:function(){svc.v6.push('');markDirty();render();}},'+ 添加直连'));
  body.appendChild(v6box);

  body.appendChild(el('div',{class:'row card-actions'},
    el('button',{class:'btn',onclick:function(){testService(key,card);}},'测试'),
    el('a',{class:'btn ghost',href:'https://'+key+'.'+base+'/',target:'_blank',rel:'noopener'},'打开入口'),
    el('button',{class:'btn danger',onclick:function(){removeService(key);}},'删除')
  ));
  body.appendChild(el('div',{class:'test-results'}));
  body.hidden=collapsed.has(key);
  card.appendChild(body);
  return card;
}
function addServiceForm(){
  var key=el('input',{type:'text',placeholder:'子域名，例如 blog'});
  var name=el('input',{type:'text',placeholder:'显示名（可选）'});
  var cf1=el('input',{type:'text',placeholder:'https://...'});
  var cf2=el('input',{type:'text',placeholder:'https://...（可选）'});
  var v6=el('input',{type:'text',placeholder:'https://...（可选）'});
  var icon=el('input',{type:'text',value:'/favicon.ico'});
  var btn=el('button',{class:'btn primary',onclick:function(){
    var k=key.value.trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9-]{0,30}$/.test(k)) return toast('子域名不合法',true);
    if(k==='admin'||state.config.services[k]||state.config.aliases[k]) return toast('该子域名已存在或保留',true);
    state.config.services[k]={name:name.value.trim()||k,enabled:true,icon:icon.value.trim()||'/favicon.ico',cf:[cf1.value.trim(),cf2.value.trim()].filter(Boolean),v6:v6.value.trim()?[v6.value.trim()]:[]};
    markDirty();
    render();
    toast('已添加，记得保存');
  }},'添加服务');
  return el('div',{class:'add-form'},
    el('h3',{text:'添加服务'}),
    el('div',{class:'grid'},
      field('子域名',key),field('显示名',name),field('CF 线路 1',cf1),field('CF 线路 2',cf2),field('IPv6 直连',v6),field('图标路径',icon)
    ),
    el('div',{class:'row'},btn)
  );
}
function servicesSection(){
  var box=el('section',{class:'panel'},
    el('div',{class:'panel-head'},el('h2',{text:'服务'}),
      el('div',{class:'row'},
        el('button',{class:'btn',id:'testAllBtn',title:'从当前浏览器测试所有服务，汇总显示在下方',onclick:function(){testAll(this);}},'测试全部'),
        el('button',{class:'btn small',onclick:function(){setAllCollapsed(true);}},'全部收起'),
        el('button',{class:'btn small',onclick:function(){setAllCollapsed(false);}},'全部展开')
      )
    )
  );
  var summary=el('div',{class:'test-summary',id:'test-summary',hidden:true},
    el('div',{class:'summary-head'},el('span',{text:'线路测试结果'}),el('button',{class:'btn small',onclick:function(){var s=$('#test-summary');var l=$('#summary-list');if(s)s.hidden=true;if(l)l.textContent='';}},'清除')),
    el('div',{class:'summary-list',id:'summary-list'})
  );
  box.appendChild(summary);
  var cards=el('div',{class:'cards'});
  Object.keys(state.config.services).sort().forEach(function(key){cards.appendChild(serviceCard(key));});
  box.appendChild(cards);
  box.appendChild(addServiceForm());
  return box;
}
function removeService(key){
  if(!confirm('删除服务 '+key+'？相关别名也会删除。')) return;
  delete state.config.services[key];
  Object.keys(state.config.aliases).forEach(function(a){if(state.config.aliases[a]===key)delete state.config.aliases[a];});
  markDirty();
  render();
}
function aliasesSection(){
  var box=el('section',{class:'panel'},el('h2',{text:'别名入口'}),el('p',{class:'hint',text:'一个服务可以有多个入口子域，例如 www → onenav。'}));
  var list=el('div',{class:'alias-list'});
  Object.keys(state.config.aliases).sort().forEach(function(a){
    list.appendChild(el('div',{class:'alias-row'},
      el('code',{text:a}),el('span',{class:'arrow',text:'→'}),el('code',{text:state.config.aliases[a]}),
      el('button',{class:'btn small danger',onclick:function(){delete state.config.aliases[a];markDirty();render();}},'删除')
    ));
  });
  var input=el('input',{type:'text',placeholder:'例如 www'});
  var select=el('select');
  Object.keys(state.config.services).sort().forEach(function(k){select.appendChild(el('option',{value:k,text:k}));});
  list.appendChild(el('div',{class:'alias-row'},input,select,
    el('button',{class:'btn small',onclick:function(){
      var a=input.value.trim().toLowerCase();
      if(!/^[a-z0-9][a-z0-9-]{0,30}$/.test(a)) return toast('别名不合法',true);
      if(a==='admin'||state.config.services[a]||state.config.aliases[a]) return toast('别名已存在或保留',true);
      if(!select.value) return toast('先添加一个服务',true);
      state.config.aliases[a]=select.value;
      markDirty();
      render();
    }},'添加')
  ));
  box.appendChild(list);
  return box;
}
function settingsSection(){
  var s=state.config.settings;
  var box=el('section',{class:'panel'},el('h2',{text:'全局设置'}),el('p',{class:'hint',text:'超时单位毫秒。直连窗口越大，有 IPv6 的客户等待越久才回落到 CF。baseDomain 只影响面板里的链接展示，不会改 DNS。'}));
  var grid=el('div',{class:'grid'});
  grid.appendChild(field('入口根域',inputEl(s.baseDomain,function(v){s.baseDomain=v.trim();markDirty();})));
  grid.appendChild(field('直连探测窗口',inputEl(String(s.directTimeoutMs),function(v){s.directTimeoutMs=Number(v)||0;markDirty();},{type:'number',min:'300',max:'5000'})));
  grid.appendChild(field('CF 探测窗口',inputEl(String(s.cfTimeoutMs),function(v){s.cfTimeoutMs=Number(v)||0;markDirty();},{type:'number',min:'500',max:'8000'})));
  box.appendChild(grid);
  return box;
}
function ioSection(){
  var ta=el('textarea',{rows:'12',spellcheck:'false'});
  ta.value=JSON.stringify(state.config,null,2);
  var box=el('section',{class:'panel'},el('h2',{text:'导入 / 导出'}),el('p',{class:'hint',text:'导出备份；粘贴 JSON 后可导入到编辑器，保存前不会生效。'}));
  box.appendChild(ta);
  box.appendChild(el('div',{class:'row'},
    el('button',{class:'btn',onclick:function(){ta.value=JSON.stringify(state.config,null,2);}},'刷新 JSON'),
    el('button',{class:'btn',onclick:function(){
      try{
        var obj=JSON.parse(ta.value);
        if(!obj||typeof obj!=='object'||!obj.services||typeof obj.services!=='object') throw new Error('缺少 services 对象');
        state.config=normalizeConfigClient(obj);
        markDirty();
        render();
        toast('已导入到编辑器，记得保存');
      }catch(e){toast('JSON 解析失败：'+e.message,true);}
    }},'导入'),
    el('button',{class:'btn',onclick:function(){
      var blob=new Blob([JSON.stringify(state.config,null,2)],{type:'application/json'});
      var url=URL.createObjectURL(blob);
      var a=el('a',{href:url,download:'service-router-config.json'});
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
    }},'下载 JSON')
  ));
  return box;
}
function render(){
  var app=$('#app');
  app.textContent='';
  if(state.warning) app.appendChild(el('div',{class:'banner',text:state.warning}));
  app.appendChild(servicesSection());
  app.appendChild(aliasesSection());
  app.appendChild(settingsSection());
  app.appendChild(ioSection());
  updateSave();
  updateMeta();
}
$('#saveBtn').addEventListener('click',save);
$('#reloadBtn').addEventListener('click',function(){
  if(state.dirty&&!confirm('有未保存的修改，确定重新读取？')) return;
  load();
});
window.addEventListener('beforeunload',function(e){
  if(state.dirty){e.preventDefault();e.returnValue='';}
});
load();
})();
`;

function panelPage() {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>路由管理</title>
<style nonce="${nonce}">${PANEL_CSS}</style>
<body>
<header class="top">
  <div class="brand"><h1>路由管理</h1><p id="meta">加载中…</p></div>
  <div class="top-actions">
    <button id="saveBtn" class="btn primary" disabled>保存</button>
    <button id="reloadBtn" class="btn">重新读取</button>
    <form method="post" action="/logout" class="inline"><button class="btn ghost" type="submit">退出</button></form>
  </div>
</header>
<main id="app" class="wrap"></main>
<div id="toast" class="toast" hidden></div>
<script nonce="${nonce}">${PANEL_JS}</script>
</body>
</html>`, { headers: adminHtmlHeaders(nonce) });
}
