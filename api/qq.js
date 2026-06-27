// Vercel Serverless Function — QQ Music API proxy
// Deploy: push to GitHub, import to Vercel, done.

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const QQ_HEADERS = { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', 'Origin': 'https://y.qq.com' };

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const options = {
      method: opts.method || 'GET',
      headers: { ...QQ_HEADERS, ...(opts.headers || {}) },
    };
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function send(res, data, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(status).json(data);
}

// ===== QQ Music: Search =====
async function qqSearch(keywords, limit = 15) {
  const u = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  u.searchParams.set('w', keywords);
  u.searchParams.set('n', String(limit));
  u.searchParams.set('p', '1');
  u.searchParams.set('format', 'json');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('g_tk', '5381');

  const res = await fetchJSON(u.toString());
  const songs = [];
  const list = (res.data && res.data.song && res.data.song.list) || [];

  list.forEach(s => {
    const singers = (s.singer || []).map(si => ({ id: si.id, name: si.name, mid: si.mid }));
    const albumMid = s.albummid || (s.album || {}).mid || '';
    songs.push({
      provider: 'qq', source: 'qq', type: 'song',
      id: s.mid || s.songmid || String(s.id),
      qqId: s.id || s.songid,
      mid: s.mid || s.songmid,
      name: s.name || s.songname || '',
      artist: singers.map(si => si.name).join(' / '),
      artists: singers,
      album: (s.album || {}).name || s.albumname || '',
      cover: albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
      duration: (s.interval || 0) * 1000,
    });
  });
  return songs;
}

// ===== QQ Music: Song URL =====
async function qqSongUrl(mid) {
  try {
    const u = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
    const payload = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: String(Math.random() * 10000000 | 0),
          songmid: [mid],
          songtype: [0],
          uin: '0',
          loginflag: 0,
          platform: '20',
        }
      }
    };
    const res = await fetchJSON(u.toString(), {
      method: 'POST',
      headers: { ...QQ_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = res && res.req_0 && res.req_0.data;
    if (data && data.midurlinfo && data.midurlinfo[0]) {
      const info = data.midurlinfo[0];
      const sip = (data.sip || [])[0] || '';
      const purl = info.purl || '';
      if (purl && sip) {
        const url = sip + purl;
        return { url: url.startsWith('http:') ? url.replace('http:', 'https:') : url, playable: true, expire: data.expire };
      }
    }
    return { url: '', playable: false, msg: 'Copyright restricted or VIP required' };
  } catch(e) {
    return { url: '', playable: false, error: e.message };
  }
}

// ===== QQ Music: Lyric =====
async function qqLyric(mid) {
  try {
    const u = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
    u.searchParams.set('songmid', mid);
    u.searchParams.set('format', 'json');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('nobase64', '0');

    const res = await fetchJSON(u.toString(), {
      headers: { ...QQ_HEADERS, Referer: 'https://y.qq.com/portal/player.html' }
    });

    // QQ lyric is base64 encoded
    let lyric = (res && res.lyric) || '';
    if (lyric && !lyric.startsWith('[')) {
      try { lyric = Buffer.from(lyric, 'base64').toString('utf8'); } catch(e) {}
    }
    const tlyric = (res && res.trans) || '';

    return { lyric, tlyric };
  } catch(e) {
    return { lyric: '', tlyric: '' };
  }
}

// ===== QQ Music: Hot Search Suggestions =====
async function qqHotSearch() {
  try {
    const u = new URL('https://c.y.qq.com/splcloud/fcgi-bin/gethotkey.fcg');
    u.searchParams.set('format', 'json');
    u.searchParams.set('platform', 'yqq.json');
    const res = await fetchJSON(u.toString());
    const hotkeys = (res.data && res.data.hotkey) || [];
    return hotkeys.map(h => h.k || h.key || '').filter(Boolean);
  } catch(e) {
    return ['周杰伦', '林俊杰', '陈奕迅', '邓紫棋', '薛之谦', 'Taylor Swift'];
  }
}

// ===== Weather (Open-Meteo, free, no key needed) =====
async function getWeather() {
  try {
    // Get location from IP
    const locRes = await fetchJSON('http://ip-api.com/json/', { headers: {} });
    const loc = typeof locRes === 'object' ? locRes : {};
    const city = loc.city || '上海';
    const lat = loc.lat || 31.23;
    const lon = loc.lon || 121.47;
    const tz = loc.timezone || 'Asia/Shanghai';

    const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=${encodeURIComponent(tz)}`;
    const wRes = await fetchJSON(wUrl, { headers: {} });
    const cw = (wRes && wRes.current_weather) || {};

    const wcode = cw.weathercode;
    const map = { 0:'晴', 1:'晴', 2:'多云', 3:'阴', 45:'雾', 51:'小雨', 61:'中雨', 71:'小雪', 80:'阵雨', 95:'雷雨' };
    const desc = map[wcode] || '多云';

    return {
      city, country: loc.country || '',
      temperature: cw.temperature,
      windspeed: cw.windspeed,
      weathercode: wcode,
      description: desc,
    };
  } catch(e) {
    return { city: '上海', temperature: 22, description: '多云' };
  }
}

// ===== Main Handler =====
module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const { action, keywords, mid, id, limit } = req.query;

  try {
    switch (action) {
      case 'search':
        if (!keywords) return send(res, { error: 'Missing keywords' }, 400);
        const songs = await qqSearch(keywords, Math.min(parseInt(limit) || 15, 30));
        return send(res, { provider: 'qq', songs });

      case 'songUrl':
        if (!mid) return send(res, { error: 'Missing song mid' }, 400);
        const urlInfo = await qqSongUrl(mid);
        return send(res, { provider: 'qq', ...urlInfo });

      case 'lyric':
        if (!mid) return send(res, { error: 'Missing song mid' }, 400);
        const lyricData = await qqLyric(mid);
        return send(res, { provider: 'qq', ...lyricData });

      case 'hotSearch':
        const hot = await qqHotSearch();
        return send(res, { hot });

      case 'weather':
        const weather = await getWeather();
        const moodQueries = { '晴':['晴天 流行','阳光 摇滚'], '多云':['午后 民谣','温暖 流行'], '阴':['安静 钢琴'], '小雨':['雨 爵士'], '雪':['冬日 民谣'] };
        const mood = moodQueries[weather.description] || ['热门 华语'];
        // Get weather-based recommendations
        let radiosongs = [];
        try {
          radiosongs = await qqSearch(mood[0], 8);
        } catch(e) {}
        return send(res, {
          ok: true,
          weather,
          radio: {
            title: weather.description + '电台',
            subtitle: weather.city,
            seedQueries: mood,
            songs: radiosongs,
          }
        });

      default:
        return send(res, {
          name: 'Mineradio Mobile API',
          version: '1.0.0',
          endpoints: ['search', 'songUrl', 'lyric', 'hotSearch', 'weather'],
          usage: '/api/qq?action=search&keywords=周杰伦&limit=15',
        });
    }
  } catch (err) {
    return send(res, { error: err.message || 'Internal error' }, 500);
  }
};
