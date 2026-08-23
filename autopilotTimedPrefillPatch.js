'use strict';

// Timed prefill queue for Autopilot.
// - Basic: 15 scheduled posts/day
// - Pro/Admin: 25 scheduled posts/day
// - Keep only a small FUTURE buffer per account to avoid AI cost bursts
// - Spread posts across the full 24-hour KST day
// - Stagger each account's schedule so accounts do not publish at the same minute
// - Rebalance existing future pending rows on startup without touching content/media
// - Publisher remains unchanged and only publishes rows whose scheduled_at <= now

const fs = require('fs');
const path = require('path');
const Module = require('module');
const cron = require('node-cron');
const dbMod = require('./db');
const { db, getAccount, getUserById } = dbMod;

const BUFFER = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BUFFER || 3));
const BATCH = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BATCH || 1));
const REFILL_CRON = String(process.env.AUTOPILOT_TIMED_REFILL_CRON || '*/10 * * * *');
const REBALANCE_SAFETY_MINUTES = Math.max(10, Number(process.env.AUTOPILOT_REBALANCE_SAFETY_MINUTES || 15));
const runningAccounts = new Set();
let refillTickRunning = false;

function dayKeyKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
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
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function plannedSlots(dayKey, target, accountId) {
  const dayMinutes = 24 * 60;
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
      if (!slots.length) continue;
      for (let i = 0; i < posts.length && i < slots.length; i++) {
        const nextIso = slots[i].toISOString();
        if (String(posts[i].scheduled_at) === nextIso) continue;
        db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=? AND status='pending'`).run(nextIso, posts[i].id);
        changed++;
        console.log(`[Autopilot][TIMED REBALANCE] account #${accountId} post #${posts[i].id} ${posts[i].scheduled_at} -> ${nextIso}`);
      }
    }
  }
  console.log(`[Autopilot][TIMED REBALANCE] done changed=${changed} safety=${REBALANCE_SAFETY_MINUTES}m window=24h`);
}

if (!global.__ME2_TIMED_PREFILL_PATCH__) {
  global.__ME2_TIMED_PREFILL_PATCH__ = true;

  try {
    const schedulerPath = path.join(__dirname, 'scheduler.js');
    let source = fs.readFileSync(schedulerPath, 'utf8');
    const apply = (from, to, already) => {
      if (already && source.includes(already)) return;
      if (!source.includes(from)) throw new Error(`[TIMED PREFILL] scheduler source pattern missing: ${from.slice(0,90)}`);
      source = source.replace(from, to);
    };

    apply(
      'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null}){',
      'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null,scheduledAt=null}){',
      'recipeCommentText=null,scheduledAt=null}){'
    );
    apply(
      "new Date().toISOString(),accountId,recipeCommentText);}",
      "String(scheduledAt||new Date().toISOString()),accountId,recipeCommentText);}",
      'String(scheduledAt||new Date().toISOString()),accountId,recipeCommentText);}'
    );
    apply(
      'async function runContentOnlyAutopilot(account,target){',
      'async function runContentOnlyAutopilot(account,target,scheduledAt=null){',
      'runContentOnlyAutopilot(account,target,scheduledAt=null)'
    );
    apply(
      'recipeCommentText:r.recipeCommentText});recordAutopilotLast',
      'recipeCommentText:r.recipeCommentText,scheduledAt});recordAutopilotLast',
      'recipeCommentText:r.recipeCommentText,scheduledAt});recordAutopilotLast'
    );
    apply(
      'async function runAutopilotOnce(account){',
      'async function runAutopilotOnce(account,scheduledAt=null){',
      'runAutopilotOnce(account,scheduledAt=null)'
    );
    apply(
      'await runContentOnlyAutopilot(account,target);return;',
      'await runContentOnlyAutopilot(account,target,scheduledAt);return;',
      'await runContentOnlyAutopilot(account,target,scheduledAt);return;'
    );
    apply(
      'recipeCommentText:result.commentLead});const last=',
      'recipeCommentText:result.commentLead,scheduledAt});const last=',
      'recipeCommentText:result.commentLead,scheduledAt});const last='
    );

    if (!source.includes('runAutopilotOnce};')) {
      if (source.includes('module.exports={startPublishJob,startInsightsJob,startAutopilotJob};')) {
        source = source.replace(
          'module.exports={startPublishJob,startInsightsJob,startAutopilotJob};',
          'module.exports={startPublishJob,startInsightsJob,startAutopilotJob,runAutopilotOnce};'
        );
      } else if (!source.includes('runAutopilotOnce')) {
        throw new Error('[TIMED PREFILL] scheduler export block missing');
      }
    }

    fs.writeFileSync(schedulerPath, source, 'utf8');
    console.log('[Autopilot][TIMED PREFILL] scheduler future-time generation hook written');
  } catch (err) {
    console.error('[Autopilot][TIMED PREFILL] source patch failed:', err.message);
    throw err;
  }

  try { rebalanceExistingFuturePending(); }
  catch (err) { console.warn('[Autopilot][TIMED REBALANCE] startup skipped:', err.message); }

  const originalLoad = Module._load;
  Module._load = function timedPrefillLoad(request, parent, isMain) {
    const exp = originalLoad.apply(this, arguments);
    if (!['./scheduler','./scheduler.js'].includes(request) || !exp || exp.__timedPrefillPatched) return exp;

    if (typeof exp.runAutopilotOnce !== 'function') {
      console.error('[Autopilot][TIMED PREFILL] runAutopilotOnce export unavailable → timed prefill disabled, normal scheduler preserved');
      return exp;
    }

    async function refillAccount(accountId) {
      if (runningAccounts.has(accountId)) return;
      const account = getAccount(accountId);
      if (!account?.autopilot_enabled) return;
      const future = futurePendingCount(accountId);
      const need = Math.min(BATCH, Math.max(0, BUFFER - future));
      if (!need) return;
      const target = targetForAccount(account);
      const slots = chooseFutureSlots(accountId, target, need);
      if (!slots.length) return;

      runningAccounts.add(accountId);
      console.log(`[Autopilot][TIMED PREFILL] account #${accountId} target=${target}/day future=${future} preparing=${slots.length}`);
      try {
        for (const slot of slots) {
          try {
            global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
            await exp.runAutopilotOnce(account, slot.toISOString());
            console.log(`[Autopilot][TIMED PREFILL] RESERVED account #${accountId} scheduled=${slot.toISOString()}`);
          } catch (err) {
            console.error(`[Autopilot][TIMED PREFILL] generation failed account #${accountId}:`, err?.response?.data || err?.message || err);
            break;
          } finally {
            if (global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID === accountId) delete global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID;
          }
        }
      } finally {
        runningAccounts.delete(accountId);
      }
    }

    exp.startAutopilotJob = function startTimedPrefillJob() {
      const tick = async () => {
        if (refillTickRunning) return;
        refillTickRunning = true;
        try {
          const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
          for (const row of accounts) await refillAccount(Number(row.id));
        } finally {
          refillTickRunning = false;
        }
      };
      cron.schedule(REFILL_CRON, () => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] tick:', e.message)), { timezone:'Asia/Seoul', noOverlap:true });
      setTimeout(() => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] startup:', e.message)), 3000);
      console.log(`[Autopilot][TIMED PREFILL] ON buffer=${BUFFER} batch=${BATCH} basic=15/day pro=25/day window=24h account-stagger=ON cron=${REFILL_CRON}`);
    };

    exp.__timedPrefillPatched = true;
    return exp;
  };

  console.log('[Autopilot][TIMED PREFILL] future schedule controller loaded · account-stagger v3 · 24h · cost-safe');
}
