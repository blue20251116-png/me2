'use strict';

// Timed prefill queue for Autopilot.
// - Basic: 15 scheduled posts/day
// - Pro/Admin: 25 scheduled posts/day
// - Keep up to 10 FUTURE pending posts prepared per account
// - Publisher is untouched: it still publishes only rows whose scheduled_at <= now
// - Generated posts always receive an explicit FUTURE scheduled_at (never "now")

const fs = require('fs');
const path = require('path');
const Module = require('module');
const cron = require('node-cron');
const dbMod = require('./db');
const { db, getAccount, getUserById } = dbMod;

const BUFFER = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BUFFER || 10));
const BATCH = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BATCH || 10));
const REFILL_CRON = String(process.env.AUTOPILOT_TIMED_REFILL_CRON || '*/10 * * * *');
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
function plannedSlots(dayKey, target) {
  // 00:30 ~ 23:30 KST, evenly distributed with small deterministic jitter.
  // Basic 15 ≈ 98 min spacing, Pro 25 ≈ 58 min spacing.
  const first = 30;
  const last = 23 * 60 + 30;
  const span = last - first;
  const out = [];
  for (let i = 0; i < target; i++) {
    const base = first + (target === 1 ? 0 : span * i / (target - 1));
    const jitter = ((i * 17 + target * 5) % 11) - 5; // -5..+5 minutes
    const min = Math.max(first, Math.min(last, Math.round(base + jitter)));
    out.push(new Date(`${dayKey}T${String(Math.floor(min / 60)).padStart(2,'0')}:${String(min % 60).padStart(2,'0')}:00+09:00`));
  }
  return out;
}
function chooseFutureSlots(accountId, target, need) {
  const nowPlusSafety = Date.now() + 10 * 60000; // never schedule within next 10 minutes
  const result = [];
  const today = dayKeyKst();
  for (let offset = 0; offset < 3 && result.length < need; offset++) {
    const day = addDay(today, offset);
    const already = countScheduledForDay(accountId, day);
    if (already >= target) continue;
    const capacity = target - already;
    const used = usedScheduleMinutes(accountId, day);
    const candidates = plannedSlots(day, target).filter(d => d.getTime() > nowPlusSafety && !used.has(d.toISOString().slice(0,16)));
    result.push(...candidates.slice(0, Math.min(capacity, need - result.length)));
  }
  return result;
}

if (!global.__ME2_TIMED_PREFILL_PATCH__) {
  global.__ME2_TIMED_PREFILL_PATCH__ = true;

  // Modify scheduler source only to pass an explicit scheduledAt through the existing
  // generation pipeline. Publishing code is not changed.
  const originalJs = Module._extensions['.js'];
  Module._extensions['.js'] = function timedPrefillLoader(mod, filename) {
    if (!filename.endsWith(`${path.sep}scheduler.js`)) return originalJs(mod, filename);
    let source = fs.readFileSync(filename, 'utf8');

    const replacements = [
      [
        'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null}){',
        'function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null,scheduledAt=null}){'
      ],
      [
        "new Date().toISOString(),accountId,recipeCommentText);}",
        "String(scheduledAt||new Date().toISOString()),accountId,recipeCommentText);}"
      ],
      ['async function runContentOnlyAutopilot(account,target){', 'async function runContentOnlyAutopilot(account,target,scheduledAt=null){'],
      ['recipeCommentText:r.recipeCommentText});recordAutopilotLast', 'recipeCommentText:r.recipeCommentText,scheduledAt});recordAutopilotLast'],
      ['async function runAutopilotOnce(account){', 'async function runAutopilotOnce(account,scheduledAt=null){'],
      ['await runContentOnlyAutopilot(account,target);return;', 'await runContentOnlyAutopilot(account,target,scheduledAt);return;'],
      ['recipeCommentText:result.commentLead});const last=', 'recipeCommentText:result.commentLead,scheduledAt});const last='],
      ['module.exports={startPublishJob,startInsightsJob,startAutopilotJob};', 'module.exports={startPublishJob,startInsightsJob,startAutopilotJob,runAutopilotOnce};']
    ];

    for (const [from, to] of replacements) {
      if (!source.includes(from)) throw new Error(`[TIMED PREFILL] scheduler source pattern missing: ${from.slice(0,80)}`);
      source = source.replace(from, to);
    }
    mod._compile(source, filename);
  };

  // Replace ONLY the autopilot generator scheduler after scheduler.js has loaded.
  const originalLoad = Module._load;
  Module._load = function timedPrefillLoad(request, parent, isMain) {
    const exp = originalLoad.apply(this, arguments);
    if (!['./scheduler','./scheduler.js'].includes(request) || !exp || exp.__timedPrefillPatched) return exp;
    if (typeof exp.runAutopilotOnce !== 'function') throw new Error('[TIMED PREFILL] runAutopilotOnce export missing');

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
          // Generation stays sequential because material-use tracking uses a global
          // current-account context. A slow generation cannot block Publisher cron,
          // because Publisher is a separate scheduled job with already prepared rows.
          const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
          for (const row of accounts) await refillAccount(Number(row.id));
        } finally {
          refillTickRunning = false;
        }
      };
      cron.schedule(REFILL_CRON, () => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] tick:', e.message)), { timezone:'Asia/Seoul', noOverlap:true });
      setTimeout(() => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] startup:', e.message)), 3000);
      console.log(`[Autopilot][TIMED PREFILL] ON buffer=${BUFFER} batch=${BATCH} basic=15/day pro=25/day cron=${REFILL_CRON}`);
    };

    exp.__timedPrefillPatched = true;
    return exp;
  };

  console.log('[Autopilot][TIMED PREFILL] future schedule controller loaded');
}
