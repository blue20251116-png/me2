'use strict';
const express = require('express');
const { requireAccount } = require('../middleware');
const { listDrafts, markCopied } = require('../../xtrack/xDrafts');

const router = express.Router();

// X companion drafts for one account (newest first).
router.get('/api/x-drafts', requireAccount, (req, res) => {
  res.json(listDrafts(req.account.id, 50));
});

// Marks a draft as posted by hand so the auto-publisher never double-posts it.
router.post('/api/x-drafts/:id/copied', requireAccount, (req, res) => {
  res.json({ ok: markCopied(Number(req.params.id), req.account.id) > 0 });
});

module.exports = router;
