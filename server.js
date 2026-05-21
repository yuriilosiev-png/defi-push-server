const express    = require('express');
const webpush    = require('web-push');
const bodyParser = require('body-parser');
const https      = require('https');

const app = express();
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if(req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── VAPID ──────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_USERNAME   = process.env.TG_USERNAME || 'DefiAnalytics2bot';

webpush.setVapidDetails(
  'mailto:admin@defi-app.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// ── Хранилище подписок (в памяти — для Render достаточно) ──────
let subscriptions = {}; // chatId → [subscription, ...]

// ── 1. Регистрация push-подписки ───────────────────────────────
app.post('/push/subscribe', (req, res) => {
  const { chatId, subscription } = req.body;
  if(!chatId || !subscription) return res.status(400).json({ok:false});
  if(!subscriptions[chatId]) subscriptions[chatId] = [];
  // Не дублировать
  const exists = subscriptions[chatId].some(s => s.endpoint === subscription.endpoint);
  if(!exists) subscriptions[chatId].push(subscription);
  console.log(`[Push] Subscribed: chatId=${chatId}, total=${subscriptions[chatId].length}`);
  res.json({ok:true});
});

// ── 2. Отправка пуша по chatId ─────────────────────────────────
async function sendPush(chatId, title, body, priority) {
  const subs = subscriptions[chatId] || [];
  if(!subs.length) return;
  const payload = JSON.stringify({ title, body, priority: priority || 3 });
  const dead = [];
  for(const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      if(e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  // Удаляем мёртвые подписки
  if(dead.length) {
    subscriptions[chatId] = subs.filter(s => !dead.includes(s.endpoint));
  }
}

// ── 3. Lookup username → chatId (через Telegram) ───────────────
app.get('/lookup/:username', async (req, res) => {
  const username = req.params.username.replace('@','');
  try {
    const updates = await tgGet('getUpdates', {limit:100, offset:-100});
    const messages = updates.result || [];
    for(const u of messages.reverse()) {
      const msg = u.message || u.channel_post;
      if(!msg) continue;
      const user = msg.from || msg.chat;
      if(user && user.username && user.username.toLowerCase() === username.toLowerCase()) {
        return res.json({ok:true, chat_id: msg.chat.id});
      }
    }
    res.json({ok:false, error:'User not found. Send /start to the bot first.'});
  } catch(e) {
    res.status(500).json({ok:false, error:e.message});
  }
});

// ── 4. Отправка алерта (TG + Push одновременно) ───────────────
app.post('/alert', async (req, res) => {
  const { chat_id, type, data } = req.body;
  if(!chat_id) return res.status(400).json({ok:false});

  let tgText = '';
  let pushTitle = '';
  let pushBody  = '';
  let pushPriority = 3;

  switch(type) {
    case 'test':
      tgText     = '✅ <b>DeFi Analytics</b>\n\nАлерты подключены и работают! 🚀';
      pushTitle  = '✅ DeFi Analytics';
      pushBody   = 'Push-уведомления работают!';
      pushPriority = 3;
      break;

    case 'hf_danger':
      tgText     = `🚨 <b>Health Factor ${data.hf}</b>\n\nHF упал ниже ${data.threshold}!\n⚠️ Риск ликвидации — пополни залог!\n\n<i>DeFi Analytics</i>`;
      pushTitle  = `🚨 Health Factor ${data.hf}`;
      pushBody   = `HF ниже ${data.threshold}! Риск ликвидации. Пополни залог немедленно!`;
      pushPriority = 5;
      break;

    case 'raw':
      // Чистый текст (для прогноза HF, диапазона и т.д.)
      tgText     = data.text || '';
      pushTitle  = 'DeFi Analytics 🔔';
      // Убираем HTML теги для push
      pushBody   = (data.text || '').replace(/<[^>]+>/g, '').slice(0, 200);
      pushPriority = 4;
      break;

    default:
      tgText = JSON.stringify(data);
  }

  const results = await Promise.allSettled([
    tgSend(chat_id, tgText),
    sendPush(chat_id, pushTitle, pushBody, pushPriority)
  ]);

  res.json({ok:true, tg: results[0].status, push: results[1].status});
});

// ── 5. VAPID public key для клиента ───────────────────────────
app.get('/push/vapid-public', (req, res) => {
  res.json({key: VAPID_PUBLIC});
});

// ── Telegram helpers ───────────────────────────────────────────
function tgGet(method, params) {
  const qs = Object.entries(params||{}).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function tgSend(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({chat_id:chatId, text, parse_mode:'HTML'});
    const req = https.request({
      hostname:'api.telegram.org',
      path:`/bot${TG_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Старт ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DeFi Push Server running on port ${PORT}`));
