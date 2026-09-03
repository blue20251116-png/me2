'use strict';

const Module = require('module');
const crypto = require('crypto');
const cron = require('node-cron');
const dbMod = require('./db');
const coupangApi = require('./coupangApi');
const { db, getAccount, getUserById } = dbMod;
const { setState, budgetState } = require('./automationState');

const BUFFER = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BUFFER || 3));
const BATCH = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BATCH || 2));
const REFILL_CRON = String(process.env.AUTOPILOT_TIMED_REFILL_CRON || '*/10 * * * *');
const REBALANCE_SAFETY_MINUTES = Math.max(10, Number(process.env.AUTOPILOT_REBALANCE_SAFETY_MINUTES || 15));
const COUPANG_PREFLIGHT_TTL_MS = Math.max(10 * 60000, Number(process.env.COUPANG_PREFLIGHT_TTL_MS || 6 * 60 * 60 * 1000));
// An auth failure must recover without restarting the process. Retry on a later refill tick.
const invalidTtl = Number(process.env.COUPANG_INVALID_TTL_MS || 5 * 60000);
const COUPANG_INVALID_TTL_MS = Number.isFinite(invalidTtl) ? Math.min(10 * 60000, Math.max(60000, invalidTtl)) : 5 * 60000;
const runningAccounts = new Set();
const coupangPreflightCache = new Map();
let refillTickRunning = false;
let lastAccountId = 0;

function dayKeyKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function kstMidnight(dayKey) { return new Date(`${dayKey}T00:00:00+09:00`); }
function addDay(dayKey, n) { return dayKeyKst(new Date(kstMidnight(dayKey).getTime() + n * 86400000)); }
function targetForAccount(account) {
  if (!account?.user_id) return 25;
  const user = getUserById(account.user_id);
  if (user?.role === 'admin') return 25;
  return String(user?.plan || '').toLowerCase() === 'pro' ? 25 : 15;
}
function dayBounds(dayKey) {
  const start = kstMidnight(dayKey);
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}
function countScheduledForDay(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).get(accountId, start, end)?.c || 0);
}
function futurePendingCount(accountId) {
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>?`).get(accountId, new Date().toISOString())?.c || 0);
}
function usedScheduleMinutes(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  return new Set(db.prepare(`SELECT scheduled_at FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).all(accountId, start, end).map(r => String(r.scheduled_at || '').slice(0,16)));
}
function accountHash(accountId, dayKey='') {
  const s = `${Number(accountId)||0}:${dayKey}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function plannedSlots(dayKey, target, accountId) {
  const dayMinutes = 1440;
  const step = dayMinutes / Math.max(1, target);
  const seed = accountHash(accountId, dayKey);
  const phase = seed % Math.max(1, Math.floor(step));
  const out = [];
  for (let i = 0; i < target; i++) {
    const itemJitter = (((seed >>> (i % 16)) + i * 19 + Number(accountId || 0) * 7) % 15) - 7;
    let minute = Math.round(phase + i * step + itemJitter);
    minute = ((minute % dayMinutes) + dayMinutes) % dayMinutes;
    out.push(new Date(`${dayKey}T${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}:00+09:00`));
  }
  return out.sort((a,b)=>a-b);
}
function chooseFutureSlots(accountId, target, need) {
  const nowPlusSafety = Date.now() + 10 * 60000;
  const result = [];
  const today = dayKeyKst();
  for (let offset = 0; offset < 3 && result.length < need; offset++) {
    const day = addDay(today, offset);
    const already = countScheduledForDay(accountId, day);
    if (already >= target) continue;
    const capacity = target - already;
    const used = usedScheduleMinutes(accountId, day);
    const candidates = plannedSlots(day, target, accountId).filter(d => d.getTime() > nowPlusSafety && !used.has(d.toISOString().slice(0,16)));
    result.push(...candidates.slice(0, Math.min(capacity, need - result.length)));
  }
  return result;
}
function rebalanceExistingFuturePending() {
  const cutoff = new Date(Date.now() + REBALANCE_SAFETY_MINUTES * 60000).toISOString();
  const accountRows = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
  let changed = 0;
  for (const row of accountRows) {
    const accountId = Number(row.id);
    const account = getAccount(accountId);
    if (!account) continue;
    const target = targetForAccount(account);
    for (let offset = 0; offset < 3; offset++) {
      const day = addDay(dayKeyKst(), offset);
      const [start, end] = dayBounds(day);
      const posts = db.prepare(`SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at ASC,id ASC`).all(accountId, cutoff, start, end);
      if (!posts.length) continue;
      const slots = plannedSlots(day, target, accountId).filter(d => d.toISOString() > cutoff);
      for (let i = 0; i < posts.length && i < slots.length; i++) {
        const nextIso = slots[i].toISOString();
        if (String(posts[i].scheduled_at) === nextIso) continue;
        db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=? AND status='pending'`).run(nextIso, posts[i].id);
        changed++;
      }
    }
  }
  console.log(`[Autopilot][TIMED REBALANCE] done changed=${changed} safety=${REBALANCE_SAFETY_MINUTES}m window=24h`);
}

function credentialFingerprint(account) {
  return crypto.createHash('sha256').update(JSON.stringify([
    String(account?.coupang_access_key || '').trim(),
    String(account?.coupang_secret_key || '').trim(),
  ])).digest('hex');
}
function isCoupangAuthError(err) {
  // A 401 from OpenAI, Threads, or a media URL is not a Coupang credential failure.
  let fromCoupang = err?.service === 'coupang';
  try {
    const config = err?.config || err?.response?.config;
    fromCoupang ||= new URL(config?.url, config?.baseURL).hostname === 'api-gateway.coupang.com';
  } catch {}
  if (!fromCoupang) return false;
  const status = Number(err?.response?.status || 0);
  const data = err?.response?.data;
  const msg = String(data?.message || data?.rMessage || err?.message || '');
  return status === 401 || String(data?.rCode) === '401' || /invalid signature|unauthorized|invalid.*(?:access.?key|secret.?key)/i.test(msg);
}
async function ensureCoupangReady(accountId, account) {
  const fp = credentialFingerprint(account);
  if (!coupangApi.hasCredentials(account)) {
    coupangPreflightCache.set(accountId, { ok:false, reason:'missing_credentials', fp, until:Date.now()+COUPANG_INVALID_TTL_MS });
    console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} API 키 없음 → OpenAI/Vision 생성 건너뜀`);
    return false;
  }
  const cached = coupangPreflightCache.get(accountId);
  if (cached && cached.fp === fp && cached.until > Date.now()) {
    if (!cached.ok) console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} cached-invalid reason=${cached.reason} → OpenAI/Vision 생성 건너뜀`);
    return cached.ok;
  }
  try {
    // OpenAI보다 먼저 실제 서명 요청 1회로 인증 상태를 검증한다. 정상 결과는 장시간 캐시한다.
    await coupangApi.searchProducts(accountId, '물티슈', 1);
    coupangPreflightCache.set(accountId, { ok:true, reason:'ok', fp, until:Date.now()+COUPANG_PREFLIGHT_TTL_MS });
    console.log(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH OK ttl=${Math.round(COUPANG_PREFLIGHT_TTL_MS/3600000)}h`);
    return true;
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    const msg = String(err?.response?.data?.message || err?.response?.data?.rMessage || err?.message || err || '');
    if (isCoupangAuthError(err)) {
      coupangPreflightCache.set(accountId, { ok:false, reason:'invalid_signature', fp, until:Date.now()+COUPANG_INVALID_TTL_MS });
      console.error(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH INVALID → OpenAI/Vision 생성 중단 reason="${msg.slice(0,160)}"`);
      return false;
    }
    // 호출 제한/일시 장애는 인증 실패로 오판하지 않는다.
    console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} check deferred status=${status||'-'} reason="${msg.slice(0,160)}"`);
    return true;
  }
}

if (!global.__ME2_TIMED_PREFILL_PATCH__) {
  global.__ME2_TIMED_PREFILL_PATCH__ = true;
  try { rebalanceExistingFuturePending(); } catch (err) { console.warn('[Autopilot][TIMED REBALANCE] startup skipped:', err.message); }

  const originalLoad = Module._load;
  Module._load = function timedPrefillLoad(request, parent, isMain) {
    const exp = originalLoad.apply(this, arguments);
    if (!['./scheduler','./scheduler.js'].includes(request) || !exp || exp.__timedPrefillPatched) return exp;
    if (typeof exp.runAutopilotOnce !== 'function') return exp;

    async function refillAccount(accountId) {
      if (runningAccounts.has(accountId)) return;
      const account = getAccount(accountId);
      if (!account?.autopilot_enabled) return;
      if (!String(account.threads_access_token || '').trim() || (account.threads_token_expires_at && Date.parse(account.threads_token_expires_at)<=Date.now())) {
        setState(accountId, 'blocked', 'THREADS_TOKEN_MISSING');
        console.warn(`[Autopilot][PREFLIGHT] account #${accountId} THREADS_TOKEN_MISSING → 생성 생략`);
        return;
      }
      if (account.user_id) {
        const user = getUserById(account.user_id);
        if (!user || user.status !== 'active' || (user.expires_at && Date.parse(user.expires_at) <= Date.now())) {
          setState(accountId, 'blocked', 'SUBSCRIPTION_INACTIVE');
          return;
        }
      }
      const future = futurePendingCount(accountId);
      const need = Math.min(BATCH, Math.max(0, BUFFER - future));
      if (!need) return;
      const target = targetForAccount(account);
      const slots = chooseFutureSlots(accountId, target, need);
      if (!slots.length) return;

      // 핵심: Coupang 인증을 OpenAI/Vision보다 먼저 확인한다.
      const coupangReady = await ensureCoupangReady(accountId, account);
      if (!coupangReady) { setState(accountId,'blocked','COUPANG_CREDENTIALS_INVALID'); return; }

      runningAccounts.add(accountId);
      setState(accountId, 'running', 'generating');
      console.log(`[Autopilot][TIMED PREFILL] account #${accountId} target=${target}/day future=${future} preparing=${slots.length}`);
      try {
        for (const slot of slots) {
          const budget = budgetState();
          if (!budget.available) {
            setState(accountId, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
            break;
          }
          try {
            global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
            await exp.runAutopilotOnce(account, slot.toISOString());
            setState(accountId, 'ready', 'reserved');
            console.log(`[Autopilot][TIMED PREFILL] RESERVED account #${accountId} scheduled=${slot.toISOString()}`);
          } catch (err) {
            const msg = String(err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || err || '');
            const status = Number(err?.response?.status || 0);
            console.error(`[Autopilot][TIMED PREFILL] generation failed account #${accountId}:`, err?.response?.data || err?.message || err);
            setState(accountId, 'retry', String(err?.code || 'GENERATION_FAILED'), new Date(Date.now()+10*60000).toISOString());
            if (isCoupangAuthError(err)) {
              coupangPreflightCache.set(accountId, { ok:false, reason:'invalid_signature', fp:credentialFingerprint(account), until:Date.now()+COUPANG_INVALID_TTL_MS });
              console.error(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} runtime AUTH INVALID → 남은 슬롯 중단 + 다음 계정 이동`);
              break;
            }
            // Stop this account's batch, but never poison the Coupang auth cache.
            if (status === 401 || err?.isContentQualityHold || err?.code==='CONTENT_QUALITY_HOLD' || err?.code==='OPENAI_HOURLY_BUDGET_EXCEEDED' || err?.__openAiNoRetry || /no credits remaining|OPENAI_HOURLY_BUDGET_EXCEEDED/i.test(msg)) break;
            console.log(`[Autopilot][TIMED PREFILL] account #${accountId} 실패 1건은 건너뛰고 다음 예약 슬롯 계속 시도`);
          } finally {
            if (global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID === accountId) delete global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID;
          }
        }
      } finally { runningAccounts.delete(accountId); }
    }

    exp.startAutopilotJob = function startTimedPrefillJob() {
      const tick = async () => {
        if (refillTickRunning) return;
        refillTickRunning = true;
        const startedAt = Date.now();
        setState(0, 'running', 'refill');
        try {
          const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
          // Resume after the last attempted account instead of starving later accounts.
          const ordered = [...accounts.filter(r=>Number(r.id)>lastAccountId), ...accounts.filter(r=>Number(r.id)<=lastAccountId)];
          for (const row of ordered) {
            const budget = budgetState();
            if (!budget.available) {
              setState(0, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
              console.log(`[Autopilot][BUDGET WAIT] retryAt=${new Date(budget.retryAt).toISOString()}`);
              return;
            }
            lastAccountId = Number(row.id);
            try { await refillAccount(lastAccountId); }
            catch (err) { setState(lastAccountId,'retry',err.code||'PREFLIGHT_FAILED'); console.error(`[Autopilot][ACCOUNT ERROR] #${lastAccountId}: ${err.message}`); }
            if (Date.now()-startedAt >= 8*60000) break;
          }
          setState(0, 'idle', 'refill complete');
        } finally { refillTickRunning = false; console.log(`[Autopilot][TICK COMPLETE] durationMs=${Date.now()-startedAt} lastAccount=${lastAccountId}`); }
      };
      cron.schedule(REFILL_CRON, () => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] tick:', e.message)), { timezone:'Asia/Seoul', noOverlap:true });
      setTimeout(() => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] startup:', e.message)), 3000);
      console.log(`[Autopilot][TIMED PREFILL] ON buffer=${BUFFER} batch=${BATCH} basic=15/day pro=25/day window=24h account-stagger=ON retry-next-slot=ON coupang-preflight=ON cron=${REFILL_CRON}`);
    };
    exp.__timedPrefillPatched = true;
    return exp;
  };

  console.log('[Autopilot][TIMED PREFILL] future schedule controller loaded · account-stagger v5 · Coupang preflight before OpenAI · 24h');
}
