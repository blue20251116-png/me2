'use strict';
// Application entry point (`npm start`).
require('dotenv').config();
require('./infra/httpDeadline').installHttpDeadline();
require('./infra/dbRetentionJob').startDbRetention();
require('./web/server').startServer();
