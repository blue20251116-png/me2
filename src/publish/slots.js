'use strict';
// When autopilot posts go out: KST day helpers, per-account daily targets, and deterministic,
// staggered publish slots inside the active window.
const { db, getAccount, getUserById } = require('../infra/db');

function dayKeyKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
function kstMidnight(dayKey) {
  return new Date(`${dayKey}T00:00:00+09:00`);
}
function addDay(dayKey, n) {
  return dayKeyKst(new Date(kstMidnight(dayKey).getTime() + n * 86400000));
}
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
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`
      )
      .get(accountId, start, end)?.c || 0
  );
}
function futurePendingCount(accountId) {
  return Number(
    db
      .prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>?`)
      .get(accountId, new Date().toISOString())?.c || 0
  );
}
function usedScheduleMinutes(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  return new Set(
    db
      .prepare(
        `SELECT scheduled_at FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`
      )
      .all(accountId, start, end)
      .map(r => String(r.scheduled_at || '').slice(0, 16))
  );
}
function accountHash(accountId, dayKey = '') {
  const s = `${Number(accountId) || 0}:${dayKey}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// 2026-09-30 (user: "조회수가 잘 안 나옴"): slots used to be spread evenly over all 24 hours, so at
// 15-25 posts/day roughly a quarter of every account's posts went out between 01:00 and 07:00 KST.
// Threads decides how far to push a post from the reactions it gets in its first hour, and at
// 3-5 AM there is nobody awake to react - those posts were effectively thrown away. Slots now
// spread over the active window only (default 07:00-24:00 KST, env-overridable), same count.
const ACTIVE_START_HOUR = Math.min(23, Math.max(0, Number(process.env.AUTOPILOT_ACTIVE_START_HOUR ?? 7) || 0));
const ACTIVE_END_HOUR = Math.min(
  24,
  Math.max(ACTIVE_START_HOUR + 1, Number(process.env.AUTOPILOT_ACTIVE_END_HOUR ?? 24) || 24)
);
// 2026-10-03 (user: "20~24개가 시간차로 50~1시간 단위로 무작위로 예약", "24시간안에", "발행속도가 너무
// 늦는데"): gap mode, on when AUTOPILOT_GAP_MIN is set. A rolling chain per account: each new post
// goes GAP_MIN..GAP_MAX minutes after the account's latest scheduled post (or from now, if that is
// already past), any hour of the day. Once a KST day holds its seeded-random DAILY_MIN..MAX posts
// (capped by the plan target), the chain resumes right after the next midnight.
const GAP_MIN = Number(process.env.AUTOPILOT_GAP_MIN || 0);
const GAP_MAX = Math.max(GAP_MIN, Number(process.env.AUTOPILOT_GAP_MAX || GAP_MIN));
const DAILY_MIN = Math.max(1, Number(process.env.AUTOPILOT_DAILY_MIN || 20));
const DAILY_MAX = Math.max(DAILY_MIN, Number(process.env.AUTOPILOT_DAILY_MAX || 24));
function dailyCount(accountId, dayKey, target) {
  const span = DAILY_MAX - DAILY_MIN + 1;
  return Math.min(target, DAILY_MIN + (accountHash(accountId, dayKey) % span));
}
function randomGapMs() {
  return (GAP_MIN + Math.floor(Math.random() * (GAP_MAX - GAP_MIN + 1))) * 60000;
}
function floorToMinute(ms) {
  return Math.floor(ms / 60000) * 60000;
}
function chainSlots(accountId, target, need) {
  const last = db
    .prepare(`SELECT MAX(scheduled_at) m FROM posts WHERE account_id=? AND status IN ('pending','posted')`)
    .get(accountId)?.m;
  const step = chainStepper(accountId, target, last ? Date.parse(last) : 0, day => countScheduledForDay(accountId, day));
  const result = [];
  while (result.length < need) {
    const next = step();
    if (!next) break;
    result.push(next);
  }
  return result;
}
// Returns a function yielding the next chained slot (Date) or null past the 3-day horizon.
// dayCount(day) gives how many posts the day already holds outside this chain.
function chainStepper(accountId, target, prevMs, dayCount) {
  // 10-30 min out, randomized so idle accounts restarting together don't all post the same minute.
  const earliest = Date.now() + (10 + Math.floor(Math.random() * 21)) * 60000;
  const horizon = kstMidnight(addDay(dayKeyKst(), 3)).getTime();
  const perDay = new Map();
  let prev = prevMs;
  return () => {
    for (;;) {
      const next = floorToMinute(Math.max(prev + randomGapMs(), earliest));
      const day = dayKeyKst(new Date(next));
      if (!perDay.has(day)) perDay.set(day, dayCount(day));
      if (perDay.get(day) >= dailyCount(accountId, day, target)) {
        // Day is full: restart just after the next midnight, still keeping >= GAP_MIN from prev.
        const resume = kstMidnight(addDay(day, 1)).getTime() + Math.floor(Math.random() * 30) * 60000;
        if (resume >= horizon) return null;
        prev = Math.max(resume, prev + GAP_MIN * 60000) - GAP_MIN * 60000;
        continue;
      }
      if (next >= horizon) return null;
      perDay.set(day, perDay.get(day) + 1);
      prev = next;
      return new Date(next);
    }
  };
}
// Startup: re-chain each account's future pending posts so they follow the latest fixed post at
// GAP_MIN..GAP_MAX instead of sitting in old fixed slots (e.g. pushed to tomorrow's early hours).
function rechainFuturePending() {
  const cutoffMs = Date.now() + 15 * 60000;
  const cutoff = new Date(cutoffMs).toISOString();
  const accountRows = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
  let changed = 0;
  for (const row of accountRows) {
    const accountId = Number(row.id);
    const account = getAccount(accountId);
    if (!account) continue;
    const posts = db
      .prepare(`SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>? ORDER BY scheduled_at,id`)
      .all(accountId, cutoff);
    if (!posts.length) continue;
    const fixed = db
      .prepare(`SELECT MAX(scheduled_at) m FROM posts WHERE account_id=? AND status IN ('pending','posted') AND scheduled_at<=?`)
      .get(accountId, cutoff)?.m;
    const movable = new Set(posts.map(p => p.id));
    const step = chainStepper(accountId, targetForAccount(account), fixed ? Date.parse(fixed) : 0, day => {
      const [start, end] = dayBounds(day);
      return db
        .prepare(`SELECT id FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`)
        .all(accountId, start, end)
        .filter(r => !movable.has(r.id)).length;
    });
    for (const p of posts) {
      const next = step();
      if (!next) break;
      const iso = next.toISOString();
      if (String(p.scheduled_at) === iso) continue;
      db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=? AND status='pending'`).run(iso, p.id);
      changed++;
    }
  }
  console.log(`[Autopilot][GAP RECHAIN] done changed=${changed} gap=${GAP_MIN}-${GAP_MAX}m daily=${DAILY_MIN}-${DAILY_MAX}`);
}
function plannedSlots(dayKey, target, accountId) {
  const windowStart = ACTIVE_START_HOUR * 60;
  const windowMinutes = (ACTIVE_END_HOUR - ACTIVE_START_HOUR) * 60;
  const step = windowMinutes / Math.max(1, target);
  const seed = accountHash(accountId, dayKey);
  const phase = seed % Math.max(1, Math.floor(step));
  const out = [];
  for (let i = 0; i < target; i++) {
    const itemJitter = (((seed >>> (i % 16)) + i * 19 + Number(accountId || 0) * 7) % 15) - 7;
    let minute = Math.round(windowStart + phase + i * step + itemJitter);
    minute = Math.min(windowStart + windowMinutes - 1, Math.max(windowStart, minute));
    out.push(
      new Date(
        `${dayKey}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+09:00`
      )
    );
  }
  return out.sort((a, b) => a - b);
}
function chooseFutureSlots(accountId, target, need) {
  if (GAP_MIN > 0) return chainSlots(accountId, target, need);
  const nowPlusSafety = Date.now() + 10 * 60000;
  const result = [];
  const today = dayKeyKst();
  for (let offset = 0; offset < 3 && result.length < need; offset++) {
    const day = addDay(today, offset);
    const already = countScheduledForDay(accountId, day);
    if (already >= target) continue;
    const capacity = target - already;
    const used = usedScheduleMinutes(accountId, day);
    const candidates = plannedSlots(day, target, accountId).filter(
      d => d.getTime() > nowPlusSafety && !used.has(d.toISOString().slice(0, 16))
    );
    result.push(...candidates.slice(0, Math.min(capacity, need - result.length)));
  }
  return result;
}
const AUTOPILOT_REBALANCE_SAFETY_MINUTES = Math.max(10, Number(process.env.AUTOPILOT_REBALANCE_SAFETY_MINUTES || 15));
function rebalanceExistingFuturePending() {
  // Gap mode schedules a rolling chain, not fixed per-day slots - re-snapping it to plannedSlots would break the gaps.
  if (GAP_MIN > 0) return rechainFuturePending();
  const cutoff = new Date(Date.now() + AUTOPILOT_REBALANCE_SAFETY_MINUTES * 60000).toISOString();
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
      const posts = db
        .prepare(
          `SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at ASC,id ASC`
        )
        .all(accountId, cutoff, start, end);
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
  console.log(
    `[Autopilot][TIMED REBALANCE] done changed=${changed} safety=${AUTOPILOT_REBALANCE_SAFETY_MINUTES}m window=24h`
  );
}

module.exports = {
  dayKeyKst,
  kstMidnight,
  addDay,
  targetForAccount,
  futurePendingCount,
  plannedSlots,
  chooseFutureSlots,
  rebalanceExistingFuturePending,
};
