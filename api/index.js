'use strict';
// Entrada serverless da Vercel: reutiliza o mesmo app Express do server.js.
module.exports = require('../server.js').app;
