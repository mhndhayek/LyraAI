const crypto = require('crypto');
module.exports = { id: () => crypto.randomBytes(8).toString('hex'), now: () => Date.now() };
