const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 读取 .env（相对路径，兼容部署平台/沙箱）；平台/系统环境变量优先，不会被覆盖
function loadEnvFile() {
  const candidates = [path.join(__dirname, '.env'), '/workspace/.env'];
  for (const f of candidates) {
    try {
      const envText = fs.readFileSync(f, 'utf-8');
      envText.split('\n').forEach(line => {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
      return;
    } catch (e) { /* 尝试下一个路径 */ }
  }
}
loadEnvFile();

// Supabase 凭据：优先环境变量/.env，缺省回退到公网 publishable(anon) 密钥（与前端 Pages 模式一致，已属公开范畴）
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://wkhfgvwonuhvksaahwpd.supabase.co').replace(/\/+$/,'');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_re2fqWcuGrGMmRczmlSTCg_N-gwQUCR';

const DATA_DIR = path.join(__dirname, '.sync_data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 云端语音转写（火山录音文件识别）上传文件的临时目录；文件需经公网 URL 供火山服务端回拉
const ASR_DIR = path.join(DATA_DIR, 'asr');
if(!fs.existsSync(ASR_DIR)) fs.mkdirSync(ASR_DIR, { recursive: true });

// 入口 HTML：优先 index.html（部署用），否则中文主文件（本地用）
const HTML_FILE = fs.existsSync(path.join(__dirname, 'index.html'))
  ? path.join(__dirname, 'index.html')
  : path.join(__dirname, '鹦趣工作台v2.0.html');
const PROJECT_ROOT = __dirname;

// 带重试的安全读取：编辑工具写入文件瞬间可能短暂不可读，重试几次即可避免 500
function readWithRetry(p, enc, tries) {
  tries = tries || 6;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return fs.readFileSync(p, enc); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 简单内存缓存，避免频繁请求 Bing
const searchCache = {};
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

// 网页正文缓存（抓取全文较重，缓存更久）
const pageCache = {};
const PAGE_CACHE_TTL = 60 * 60 * 1000; // 60 分钟

// 解码 HTML 实体
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/g, "'")
    .replace(/&#0*160;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch(e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch(e) { return m; } });
}
// 去除 HTML 标签并压缩空白
function stripHtml(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// 从 HTML 抽取正文可读文本（尽量定位 article/main/.content，去除脚本样式与噪声）
function extractReadableText(html) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');
  let main = '';
  const containers = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class="[^"]*content[\s\S]*?"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*content[\s\S]*?"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*post[\s\S]*?"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*article[\s\S]*?"[^>]*>([\s\S]*?)<\/div>/i
  ];
  for (const re of containers) {
    const m = h.match(re);
    if (m && m[1] && m[1].length > main.length) main = m[1];
  }
  const bodyMatch = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = main || (bodyMatch ? bodyMatch[1] : h);
  let text = stripHtml(source)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).filter(l => l.length > 1).join('\n');
  return text.trim();
}
function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).trim() : '';
}

// 解析 Bing 视频搜索结果（videos.search）
function parseBingVideos(html) {
  const results = [];
  const re = /<a\b[^>]*class="[^"]*mc_vtvc_link[^"]*"[^>]*>/gi;
  let m;
  while((m = re.exec(html)) !== null && results.length < 12) {
    const tag = m[0];
    const hrefM = tag.match(/href="([^"]*)"/i);
    const ariaM = tag.match(/aria-label="([^"]*)"/i);
    if(!hrefM || !ariaM) continue;
    const url = hrefM[1];
    const label = decodeEntities(ariaM[1]);
    let title = label, source = '', duration = '', pubTime = '', uploader = '';
    const srcIdx = label.indexOf('来源:');
    if(srcIdx >= 0) {
      title = label.slice(0, srcIdx).trim();
      const rest = label.slice(srcIdx + 3);
      const srcM = rest.match(/\s*([^\s·]+)/);
      if(srcM) source = srcM[1];
      const durM = rest.match(/时长:\s*([^·]+)/);
      if(durM) duration = durM[1].trim();
      const timeM = rest.match(/上传时间:\s*([^·]+)/);
      if(timeM) pubTime = timeM[1].trim();
      const upM = rest.match(/上传人:\s*([^·]+)/);
      if(upM) uploader = upM[1].trim();
    }
    if(!title) continue;
    results.push({ title, url, source, duration, pubTime, uploader, video: true });
  }
  return results;
}

// 解析 Bing 搜索结果
function parseBing(html) {
  const results = [];
  const algoRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while((m = algoRe.exec(html)) !== null && results.length < 12) {
    const block = m[1];
    // 链接 + 标题（Bing 的 <h2> 可能带 class 属性）
    const aMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    let url = '', title = '';
    if(aMatch) { url = aMatch[1]; title = stripHtml(aMatch[2]); }
    else {
      const tMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      if(tMatch) title = stripHtml(tMatch[1]);
    }
    if(!title) continue;
    // 摘要：抓取该结果块内全部段落，拼成更完整的摘要（而非仅首段）
    let snippet = '';
    const allP = block.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const parts = allP.map(m => stripHtml(m.replace(/<p[^>]*>/i, '').replace(/<\/p>/i, ''))).filter(Boolean);
    snippet = parts.join(' ').slice(0, 400);
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch(e) {}
    results.push({ title, url, snippet, domain });
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // === 联网搜索 API ===
  if(pathname === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const stype = (url.searchParams.get('type') || 'web').toLowerCase();
    if(!q) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing q' }));
      return;
    }
    const cacheKey = stype + '::' + q;
    const now = Date.now();
    if(searchCache[cacheKey] && now - searchCache[cacheKey].t < SEARCH_CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: q, type: stype, results: searchCache[cacheKey].results, cached: true }));
      return;
    }
    try {
      let target, results;
      if(stype === 'video') {
        target = 'https://cn.bing.com/videos/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN';
        const r = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cookie': 'SRCHHPGUSR=SRCHLANG=zh-Hans;_EDGE_S=mkt=zh-CN;_EDGE_V=1'
          }
        });
        results = parseBingVideos(await r.text());
      } else {
        target = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&ensearch=0';
        const r = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cookie': 'SRCHHPGUSR=SRCHLANG=zh-Hans;_EDGE_S=mkt=zh-CN;_EDGE_V=1'
          }
        });
        results = parseBing(await r.text());
      }
      searchCache[cacheKey] = { t: now, results };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: q, type: stype, results, count: results.length }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: q, type: stype, results: [], error: String(e && e.message || e) }));
    }
    return;
  }

  // === 抓取网页正文全文（百度百科等，供"网页全面内容"展示）===
  if(pathname === '/api/fetch-page') {
    const target = (url.searchParams.get('url') || '').trim();
    if(!/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing or invalid url' }));
      return;
    }
    const cacheKey = 'page::' + target;
    const now = Date.now();
    if(pageCache[cacheKey] && now - pageCache[cacheKey].t < PAGE_CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: target, title: pageCache[cacheKey].title, text: pageCache[cacheKey].text, cached: true }));
      return;
    }
    try {
      const r = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(9000)
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const scan = buf.toString('utf-8');
      // 1. 优先 HTTP 响应头声明的 charset
      const ct = r.headers.get('content-type') || '';
      const hm = ct.match(/charset=["']?\s*([\w-]+)/i);
      // 2. 其次 HTML <meta> 标签声明的 charset
      const cm = scan.match(/charset=["']?\s*([\w-]+)/i);
      let cs = (hm ? hm[1] : (cm ? cm[1] : '')).toLowerCase();
      // 3. 仍未识别时，先按 UTF-8 试解码；若出现替换字符（U+FFFD），回退为 GBK
      if(!cs) {
        const asUtf8 = new TextDecoder('utf-8').decode(buf);
        cs = /�/.test(asUtf8) ? 'gbk' : 'utf-8';
      }
      let html;
      try { html = new TextDecoder(cs === 'gb2312' ? 'gbk' : cs).decode(buf); }
      catch(e) { html = scan; }
      const title = extractTitle(html);
      const text = extractReadableText(html);
      pageCache[cacheKey] = { t: now, title, text };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: target, title, text }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: target, title: '', text: '', error: String(e && e.message || e) }));
    }
    return;
  }

  // === AI 深度回答（多供应商代理：DeepSeek / 火山方舟 Ark）===
  // 客户端可传：q（问题）、key（API Key）、provider('deepseek'|'ark')、baseUrl（自定义兼容端点）、model（模型名）
  // 未传 baseUrl 时按 provider 选用默认端点：
  //   deepseek -> https://api.deepseek.com/chat/completions
  //   ark      -> https://ark.cn-volcengine.com/api/v3/chat/completions
  if(pathname === '/api/ai') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        const payload = JSON.parse(body || '{}');
        const q = payload.q || '';
        const apiKey = payload.key || process.env.DEEPSEEK_API_KEY;
        if(!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '缺少 API Key（请在界面「⚙️ 设置」中填写 DeepSeek Key 或火山方舟 Ark Key，或设置环境变量 DEEPSEEK_API_KEY）' }));
          return;
        }
        if(!q) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '缺少问题 q' }));
          return;
        }
        const provider = (payload.provider || 'deepseek').toLowerCase();
        let baseUrl = payload.baseUrl;
        if(!baseUrl) {
          baseUrl = provider === 'ark'
            ? 'https://ark.cn-volcengine.com/api/v3/chat/completions'
            : 'https://api.deepseek.com/chat/completions';
        }
        // 统一补全到 /chat/completions（兼容只填了域名根路径的情况）
        if(!/\/chat\/completions$/.test(baseUrl)) baseUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const defaultModel = provider === 'ark' ? (process.env.ARK_MODEL || 'deepseek-v3-250324') : 'deepseek-chat';
        const model = payload.model || defaultModel;
        const context = Array.isArray(payload.context) ? payload.context.filter(Boolean).join('\n') : '';
        // 允许客户端按需指定输出长度上限（百科等长文场景需要更大预算）；默认 1400，封顶 8000
        const maxTokens = Math.min(8000, Math.max(200, Number(payload.maxTokens) || 1400));
        const system = '你是「鹦趣工作台」的养鸟知识助手，专注鹦鹉与宠物鸟的饲养、健康、行为、训练与选品。请用简体中文、条理清晰地回答，可适当使用小标题与列表，内容要专业、实用、可执行。若用户问到最新用品或爆款，请结合提供的检索资料作答。';
        const userMsg = (context ? '【联网检索参考资料】\n' + context + '\n\n' : '') + '【用户问题】' + q;
        const upstream = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.7,
            max_tokens: maxTokens
          })
        });
        if(!upstream.ok) {
          const t = await upstream.text();
          throw new Error((provider === 'ark' ? '火山方舟 Ark' : 'DeepSeek') + ' ' + upstream.status + ': ' + t.slice(0, 200));
        }
        const j = await upstream.json();
        const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ answer }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ answer: '', error: String(e && e.message || e) }));
      }
    });
    return;
  }

  // === 云端语音转写（火山引擎「录音文件识别标准版 / 豆包语音」）===
  // 接收上传的音频/视频二进制（原始 body），保存后通过公网 URL 交给火山服务端识别，轮询取回文本。
  // 凭证优先级：请求头 x-volc-appid/token/cluster > 服务端环境变量 VOLC_APPID/TOKEN/CLUSTER。
  // 公网地址：环境变量 ASR_PUBLIC_BASE（需为公网可达，否则火山无法回拉音频）；缺省用请求 Host。
  if(pathname === '/api/transcribe') {
    if(req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '仅支持 POST' }));
      return;
    }
    (async () => {
      try {
        const appid = (req.headers['x-volc-appid'] || process.env.VOLC_APPID || '').toString().trim();
        const token = (req.headers['x-volc-token'] || process.env.VOLC_TOKEN || '').toString().trim();
        const cluster = (req.headers['x-volc-cluster'] || process.env.VOLC_CLUSTER || '').toString().trim();
        if(!appid || !token || !cluster) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '缺少火山语音识别凭证（appid / token / cluster）。请在「⚙️ 设置 → 云端语音转写」填写，或在服务端设置 VOLC_APPID / VOLC_TOKEN / VOLC_CLUSTER 环境变量。' }));
          return;
        }
        const fname = (req.headers['x-filename'] || 'audio.bin').toString();
        const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        // 累加原始 body（封顶 200MB）
        const MAX = 200 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        await new Promise((resolve, reject) => {
          req.on('data', c => { size += c.length; if(size > MAX) { const e = new Error('文件过大（超过 200MB）'); e.code = 1011; reject(e); req.destroy(); } else chunks.push(c); });
          req.on('end', resolve);
          req.on('error', reject);
        });
        const buf = Buffer.concat(chunks);
        if(!buf.length) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '空文件' })); return; }
        const id = crypto.randomBytes(12).toString('hex');
        const rawExt = (fname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
        const allowed = ['mp3','wav','ogg','m4a','mp4','webm','aac','flac','amr','wma','opus'];
        const safeExt = allowed.includes(rawExt) ? rawExt : 'bin';
        const storedName = id + '.' + safeExt;
        fs.writeFileSync(path.join(ASR_DIR, storedName), buf);
        // 火山需通过公网 URL 回拉音频（优先级：请求头 x-asr-public > 环境变量 ASR_PUBLIC_BASE > 请求 Host）
        const publicBase = ((req.headers['x-asr-public'] && req.headers['x-asr-public'].toString().trim()) || process.env.ASR_PUBLIC_BASE || ('http://' + (req.headers.host || 'localhost:3000'))).replace(/\/+$/, '');
        const audioUrl = publicBase + '/asr-file/' + encodeURIComponent(storedName);
        const SUBMIT = process.env.VOLC_SUBMIT_URL || 'https://openspeech.bytedance.com/api/v1/auc/submit';
        const QUERY = process.env.VOLC_QUERY_URL || 'https://openspeech.bytedance.com/api/v1/auc/query';
        const authHeader = 'Bearer; ' + token;
        const formatMap = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', mp4: 'mp4' };
        const submitBody = {
          app: { appid, token, cluster },
          user: { uid: 'parrot-workbench-' + id.slice(0, 10) },
          audio: Object.assign({ url: audioUrl }, formatMap[safeExt] ? { format: formatMap[safeExt] } : {}),
          additions: { use_itn: 'False', use_punc: 'True', with_speaker_info: 'False' }
        };
        const submitResp = await fetch(SUBMIT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': authHeader },
          body: JSON.stringify(submitBody),
          signal: AbortSignal.timeout(20000)
        });
        const submitJson = await submitResp.json().catch(() => ({}));
        const submitCode = submitJson && submitJson.resp && submitJson.resp.code;
        if(submitCode !== 1000) {
          throw new Error('火山提交任务失败：code=' + submitCode + '，' + ((submitJson.resp && submitJson.resp.message) || '未知错误'));
        }
        const taskId = submitJson.resp.id;
        const queryBody = { appid, token, cluster, id: taskId };
        let text = '', utterances = [];
        const deadline = Date.now() + 300000; // 最多等待 5 分钟
        while(Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 3000));
          const qResp = await fetch(QUERY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': authHeader },
            body: JSON.stringify(queryBody),
            signal: AbortSignal.timeout(20000)
          });
          const qJson = await qResp.json().catch(() => ({}));
          const c = qJson && qJson.resp && qJson.resp.code;
          if(c === 1000) { text = (qJson.resp.text || ''); utterances = qJson.resp.utterances || []; break; }
          if(c < 2000 && c !== 1000) { throw new Error('火山识别失败：code=' + c + '，' + ((qJson.resp && qJson.resp.message) || '未知错误')); }
          // 2000/2001 表示处理中，继续轮询
        }
        let finalText = text || (utterances.length ? utterances.map(u => u.text).join('\n') : '');
        // 清理临时文件（识别完成后即删除，避免堆积；火山默认保存 24h，无妨）
        try { fs.unlinkSync(path.join(ASR_DIR, storedName)); } catch(_) {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ text: finalText, utterances }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ text: '', error: String(e && e.message || e) }));
      }
    })();
    return;
  }

  // === 回传云端转写用的音频文件（供火山服务端按公网 URL 回拉）===
  if(pathname.startsWith('/asr-file/')) {
    const file = decodeURIComponent(pathname.slice('/asr-file/'.length));
    if(!/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(file)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad name');
      return;
    }
    const fp = path.join(ASR_DIR, path.basename(file));
    if(!fs.existsSync(fp)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = file.split('.').pop().toLowerCase();
    const mimeMap = { mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', mp4:'video/mp4', webm:'video/webm', m4a:'audio/mp4', aac:'audio/aac', flac:'audio/flac', amr:'audio/amr', wma:'audio/x-ms-wma', opus:'audio/ogg', bin:'application/octet-stream' };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // === 同步 API ===
  // POST /api/sync/:code - 上传数据
  // GET /api/sync/:code - 拉取数据
  if(pathname.startsWith('/api/sync/')) {
    const code = pathname.split('/').pop().toUpperCase();
    if(!/^[A-Z0-9]{6}$/.test(code)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid sync code' }));
      return;
    }
    const filePath = path.join(DATA_DIR, code + '.json');
    // 有 Supabase 环境变量则云端存储，否则回退到本地文件（兼容无云环境）
    const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);

    if(req.method === 'POST' || req.method === 'PUT') {
      // 关键修复：用 Buffer 数组累积原始字节，等请求完整接收后再统一按 UTF-8 解码一次。
      // 旧写法 `body += chunk` 会在每个数据块上单独调用 Buffer.toString('utf-8')，
      // 当中文（每字 3 字节）的多字节字符恰好落在 TCP 分包边界时会被截断成 U+FFFD 乱码，
      // 且因为替换符仍是合法 UTF-8，JSON.parse 不报错，于是乱码被静默写入云端。
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = JSON.parse(body);
          if(useSupabase) {
            const sbUrl = SUPABASE_URL.replace(/\/+$/,'') + '/rest/v1/workbench_sync';
            const hdrs = {
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Content-Type': 'application/json; charset=utf-8',
              'Prefer': 'resolution=merge-duplicates'
            };
            const r = await fetch(sbUrl, {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify({ code, data, updated_at: new Date().toISOString() })
            });
            if(!r.ok) { const t = await r.text(); throw new Error('SB ' + r.status + ' ' + t); }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, backend: 'supabase', time: new Date().toISOString() }));
          } else {
            data._sync_time = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, backend: 'file', time: data._sync_time }));
          }
        } catch(e) {
          console.error('sync save error', e);
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Invalid JSON / sync failed' }));
        }
      });
      return;
    }

    if(req.method === 'GET') {
      try {
        if(useSupabase) {
          const sbUrl = SUPABASE_URL.replace(/\/+$/,'') + '/rest/v1/workbench_sync?code=eq.' + encodeURIComponent(code) + '&select=data';
          const r = await fetch(sbUrl, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
          });
          if(!r.ok) throw new Error('SB ' + r.status);
          const arr = await r.json();
          if(!Array.isArray(arr) || !arr.length) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'No data for this sync code' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(arr[0].data));
        } else {
          if(fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(data);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'No data for this sync code' }));
          }
        }
      } catch(e) {
        console.error('sync load error', e);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'sync load failed' }));
      }
      return;
    }
  }

  // === 静态文件 ===
  if(pathname === '/' || pathname === '/index.html') {
    try {
      const html = readWithRetry(HTML_FILE, 'utf-8');
      // 不缓存主文档，避免浏览器/代理缓存到编辑过程中的中间版本（导致按钮行为异常等怪问题）
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>加载中</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#888">页面正在保存，请刷新重试…</body></html>');
    }
    return;
  }

  // === 静态图片资源 ===
  if(pathname.startsWith('/assets/')) {
    const assetPath = path.normalize(path.join(PROJECT_ROOT, pathname));
    if(assetPath.startsWith(path.join(PROJECT_ROOT, 'assets') + path.sep) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      try {
        const ext = path.extname(assetPath).toLowerCase();
        let mime = 'application/octet-stream';
        if(ext === '.png') mime = 'image/png';
        else if(ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0' });
        res.end(readWithRetry(assetPath));
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }
  }

  // === 工作区内的独立页面：与主应用同源，共享 localStorage ===
  if(pathname.toLowerCase().endsWith('.html')) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch (e) { decoded = pathname; }
    if(decoded.includes('..')) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad path'); return; }
    const fp = path.normalize(path.join(PROJECT_ROOT, decoded));
    if(fp.startsWith(PROJECT_ROOT + path.sep) && fp !== HTML_FILE && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      try {
        const html = readWithRetry(fp, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(html);
        return;
      } catch (e) {}
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Parrot Workbench running on port ' + PORT);
});
