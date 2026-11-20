const db = require('./config/database');
db.prepare("DELETE FROM sync_config WHERE key IN ('tenant_id','branch_id')").run();
console.log('Sync config reset done — Setup screen will appear on next refresh.');
process.exit(0);
