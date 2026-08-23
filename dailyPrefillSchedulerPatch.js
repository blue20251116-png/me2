'use strict';

// Rolling pre-generation queue:
// - Basic: 15/day
// - Pro: 25/day
// - Keep up to 10 future posts prepared per account
// - Generate at most 10 missing posts per refill pass
// - Generation is account-scoped so one slow account does not stop others

const fs = require('fs');
const path = require('path');
const Module = require('module');
const cron = require('node-cron');

const BUFFER_TARGET = Math.max(1, Number(process.env.AUTOPILOT_PREFILL_BUFFER || 10));
const BATCH_MAX = Math.max(1, Number(process.env.AUTOPILOT_PREFILL_BATCH || 10));
const REFILL_CRON = String(process.env.AUTOPILOT_PREFILL_CRON || '*/10 * * * *');
const runningAccounts = new Set();
if (!global.__ME2_PREFILL_SLOTS) global.__ME2_PREFILL_SLOTS = new Map();

function dayKeyKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function kstMidnight(dayKey) { return new Date(`${dayKey}T00:00:00+09:00`); }
function addDays(dayKey, n) {
  const d = new Date(kstMidnight(dayKey).getTime() + n * 86400000);
  return dayKeyKst(d);
}
function dailyTarget(dbMod, account) {
  if (!account?.user_id) return 25;
  const user = dbMod.getUserById?.(account.user_id);
  if (user?.role === 'admin') return Math.max(1, Number(process.env.ADMIN_AUTOPILOT_DAILY_TARGET || 25));
  return String(user?.plan || '').toLowerCase() === 'pro' ? 25 : 15;
}
function planDaySlots(dayKey, count) {
  // Spread across almost the entire KST day so overnight publishing is supported.
  const start = 20;
  const end = 23 * 60 + 40;
  const span = end - start;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const base = start + (count === 1 ? 0 : span * i / (count - 1));
    const jitter = ((i * 19 + count * 7) % 11) - 5; // deterministic -5..+5m
    const m = Math.max(start, Math.min(end, Math.round(base + jitter)));
    slots.push(new Date(`${dayKey}T${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00+09:00`));
  }
  return slots;
}
function countDay(db, accountId, dayKey) {
  const start = kstMidnight(dayKey).toISOString();
  const end = new Date(kstMidnight(dayKey).getTime() + 86400000).toISOString();
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).get(accountId, start, end)?.c || 0);
}
function futurePending(db, accountId) {
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>?`).get(accountId, new Date().toISOString())?.c || 0);
}
function existingMinutes(db, accountId, dayKey) {
  const start = kstMidnight(dayKey).toISOString();
  const end = new Date(kstMidnight(dayKey).getTime() + 86400000).toISOString();
  return new Set(db.prepare(`SELECT scheduled_at FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).all(accountId, start, end).map(r => String(r.scheduled_at || '').slice(0,16)));
}
function chooseFutureSlots(db, accountId, target, need) {
  const result = [];
  const now = Date.now() + 5 * 60000;
  const today = dayKeyKst();
  for (let dayOffset = 0; dayOffset < 3 && result.length < need; dayOffset++) {
    const day = addDays(today, dayOffset);
    const remaining = Math.max(0, target - countDay(db, accountId, day));
    if (!remaining) continue;
    const used = existingMinutes(db, accountId, day);
    const candidates = planDaySlots(day, target).filter(s => s.getTime() > now && !used.has(s.toISOString().slice(0,16)));
    result.push(...candidates.slice(0, Math.min(remaining, need - result.length)));
  }
  return result;
}

// Make saveAutopilotPost use the reserved future slot instead of "now".
// Exact source replacement only; fail open if the scheduler changes later.
const originalJs = Module._extensions['.js'];
Module._extensions['.js'] = function prefillSchedulerLoader(mod, filename) {
  if (!filename.endsWith(`${path.sep}scheduler.js`)) return originalJs(mod, filename);
  let source = fs.readFileSync(filename, 'utf8');
  const needle = "new Date().toISOString(),accountId,recipeCommentText";
  const replacement = "(global.__ME2_PREFILL_SLOTS?.get(Number(accountId))||new Date().toISOString()),accountId,recipeCommentText";
  if (source.includes(needle)) source = source.replace(needle, replacement);
  else console.warn('[Autopilot][PREFILL] scheduled_at source pattern not found; normal scheduler timing retained');
  mod._compile(source, filename);
};

const originalLoad = Module._load;
Module._load = function prefillLoad(request, parent, isMain) {
  const exp = originalLoad.apply(this, arguments);
  if (!request.endsWith('/scheduler') && request !== './scheduler' && request !== './scheduler.js') return exp;
  if (!exp || exp.__prefill10Patched) return exp;
  const dbMod = originalLoad.call(this, './db', parent, isMain);
  const db = dbMod?.db;
  const generateOne = exp.__runAutopilotOnce;
  if (!db?.prepare || typeof generateOne !== 'function') {
    console.warn('[Autopilot][PREFILL] one-shot generator hook unavailable; existing autopilot retained');
    return exp;
  }

  async function refillAccount(accountId) {
    if (runningAccounts.has(accountId)) return;
    const account = dbMod.getAccount?.(accountId);
    if (!account?.autopilot_enabled) return;
    const future = futurePending(db, accountId);
    const need = Math.min(BATCH_MAX, Math.max(0, BUFFER_TARGET - future));
    if (!need) return;
    const target = dailyTarget(dbMod, account);
    const slots = chooseFutureSlots(db, accountId, target, need);
    if (!slots.length) return;

    runningAccounts.add(accountId);
    console.log(`[Autopilot][PREFILL 10] account #${accountId} targetDay=${target} future=${future} create=${slots.length}`);
    try {
      for (const slot of slots) {
        global.__ME2_PREFILL_SLOTS.set(accountId, slot.toISOString());
        global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
        try {
          await generateOne(account);
          console.log(`[Autopilot][PREFILL 10] reserved account #${accountId} at=${slot.toISOString()}`);
        } catch (err) {
          console.error(`[Autopilot][PREFILL 10] generation failed account #${accountId}:`, err?.response?.data || err?.message || err);
          break;
        } finally {
          global.__ME2_PREFILL_SLOTS.delete(accountId);
          if (global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID === accountId) delete global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID;
        }
      }
    } finally {
      runningAccounts.delete(accountId);
    }
  }

  exp.startAutopilotJob = function startPrefillAutopilotJob() {
    const tick = () => {
      const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
      // Deliberately do not await all accounts in one global loop. Each account owns
      // its lock, so a slow media/API request cannot freeze every other account.
      for (const row of accounts) refillAccount(Number(row.id)).catch(e => console.error('[Autopilot][PREFILL 10] tick error:', e.message));
    };
    cron.schedule(REFILL_CRON, tick, { timezone: 'Asia/Seoul', noOverlap: true });
    setTimeout(tick, 3000);
    console.log(`[Autopilot][PREFILL 10] 활성화 buffer=${BUFFER_TARGET} batch=${BATCH_MAX} basic=15/day pro=25/day cron=${REFILL_CRON}`);
  };
  exp.__prefill10Patched = true;
  return exp;
};
