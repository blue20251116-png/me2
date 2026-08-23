'use strict';

/**
 * Daily prefill scheduler for Autopilot.
 *
 * Goal:
 * - Prepare the whole daily quota ahead of publish time.
 * - Basic/default users: 15 posts/day.
 * - Pro users: 25 posts/day.
 * - Keep the existing publisher responsible only for publishing pending rows.
 *
 * This patch deliberately works through scheduler exports and DB rows instead of
 * replacing the publisher. Generation failures therefore do not block already
 * prepared posts from being published.
 */
const Module = require('module');
const originalLoad = Module._load;
const runningAccounts = new Set();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function localDayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}
function kstDate(dayKey, hour, minute) {
  return new Date(`${dayKey}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+09:00`);
}
function planSlots(dayKey, count) {
  // Spread posts across 07:30-23:30 KST. Deterministic jitter avoids bunching
  // while keeping the full day's schedule known in advance.
  const start = 7 * 60 + 30;
  const end = 23 * 60 + 30;
  const span = end - start;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const base = start + (count === 1 ? 0 : (span * i / (count - 1)));
    const jitter = ((i * 17 + count * 11) % 13) - 6; // -6..+6 min
    const minuteOfDay = Math.max(start, Math.min(end, Math.round(base + jitter)));
    slots.push(kstDate(dayKey, Math.floor(minuteOfDay / 60), minuteOfDay % 60));
  }
  return slots;
}
function getDailyLimit(account) {
  const candidates = [
    account?.daily_publish_limit,
    account?.publish_daily_limit,
    account?.plan_daily_limit,
    account?.user_daily_limit
  ].map(Number).filter(Number.isFinite);
  if (candidates.length) return Math.max(1, Math.floor(candidates[0]));
  const plan = String(account?.plan || account?.subscription_plan || account?.tier || '').toLowerCase();
  return /pro/.test(plan) ? 25 : 15;
}

Module._load = function(request, parent, isMain) {
  const exp = originalLoad.apply(this, arguments);
  if (!request.endsWith('/scheduler') && request !== './scheduler' && request !== './scheduler.js') return exp;
  if (!exp || exp.__dailyPrefillPatched) return exp;

  let dbMod, accountsMod;
  try { dbMod = originalLoad.call(this, './db', parent, isMain); } catch (_) { return exp; }
  try { accountsMod = originalLoad.call(this, './accounts', parent, isMain); } catch (_) { accountsMod = null; }
  const db = dbMod?.db || dbMod?.default || dbMod;
  if (!db?.prepare) return exp;

  const originalStart = exp.startAutopilotJob;
  if (typeof originalStart !== 'function') return exp;

  // Capture the original generator by temporarily intercepting pending inserts.
  // The existing scheduler generates one complete post (body/link/media/comment),
  // then this patch moves scheduled_at to the precomputed future slot.
  async function generateOneViaExistingJob(accountId, desiredSlot) {
    const before = db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM posts WHERE account_id=?`).get(accountId)?.id || 0;
    // Existing autopilot tick is still used as the generation engine. Setting
    // autopilot_next_at to now makes the account due without changing content logic.
    try { db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(new Date(0).toISOString(), accountId); } catch (_) {}
    if (typeof exp.__runAutopilotOnce === 'function') await exp.__runAutopilotOnce(accountId);
    else return false;
    const row = db.prepare(`SELECT id FROM posts WHERE account_id=? AND id>? ORDER BY id DESC LIMIT 1`).get(accountId, before);
    if (!row) return false;
    db.prepare(`UPDATE posts SET scheduled_at=?, status='pending' WHERE id=?`).run(desiredSlot.toISOString(), row.id);
    return true;
  }

  async function prefillAccount(account) {
    const accountId = Number(account?.id);
    if (!accountId || runningAccounts.has(accountId) || !account?.autopilot_enabled) return;
    runningAccounts.add(accountId);
    try {
      const day = localDayKey();
      const dayStart = kstDate(day, 0, 0).toISOString();
      const dayEnd = new Date(kstDate(day, 0, 0).getTime() + 86400000).toISOString();
      const limit = getDailyLimit(account);
      const existing = db.prepare(`SELECT id,scheduled_at,status FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted') ORDER BY scheduled_at`).all(accountId, dayStart, dayEnd);
      const slots = planSlots(day, limit);
      const used = new Set(existing.map(r => String(r.scheduled_at || '').slice(0,16)));
      const missing = slots.filter(s => !used.has(s.toISOString().slice(0,16))).slice(0, Math.max(0, limit - existing.length));
      if (!missing.length) return;
      console.log(`[Autopilot][DAILY PREFILL] account #${accountId} day=${day} target=${limit} existing=${existing.length} missing=${missing.length}`);
      for (const slot of missing) {
        const ok = await generateOneViaExistingJob(accountId, slot);
        if (!ok) {
          console.warn(`[Autopilot][DAILY PREFILL] generator hook unavailable account #${accountId}; existing autopilot retained`);
          break;
        }
        console.log(`[Autopilot][DAILY PREFILL] reserved account #${accountId} at=${slot.toISOString()}`);
        await sleep(2500);
      }
    } catch (err) {
      console.error(`[Autopilot][DAILY PREFILL] account failure #${account?.id}:`, err?.message || err);
    } finally { runningAccounts.delete(accountId); }
  }

  // Expose a hook only when scheduler later provides it. This file is intentionally
  // fail-open: if the current scheduler cannot expose one-shot generation, normal
  // autopilot continues unchanged rather than risking production publishing.
  exp.startDailyPrefillJob = function startDailyPrefillJob() {
    const cron = require('node-cron');
    cron.schedule('5 */2 * * *', async () => {
      let accounts = [];
      try {
        const list = db.prepare(`SELECT * FROM accounts WHERE autopilot_enabled=1`).all();
        accounts = Array.isArray(list) ? list : [];
      } catch (_) {}
      for (const account of accounts) await prefillAccount(account);
    }, { timezone: 'Asia/Seoul', noOverlap: true });
  };
  exp.__dailyPrefillPatched = true;
  return exp;
};
