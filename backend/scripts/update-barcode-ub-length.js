require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    console.log('Updating ub_quantity_length for 6-digit code products...\n');

    // Set ub_quantity_length = 5 only for products whose code is exactly 6 digits
    // and whose ub_quantity_length is still at the default (0 = not configured)
    const result = await client.query(`
      UPDATE products
      SET ub_quantity_length = 5
      WHERE LENGTH(code) = 6
        AND ub_quantity_length = 0
      RETURNING id, code, name
    `);

    if (result.rows.length === 0) {
      console.log('No products needed updating (all 6-digit code products already configured).');
    } else {
      result.rows.forEach(r => console.log(`  UPDATED  [${r.code}] ${r.name}`));
      console.log(`\n✓ Done! ${result.rows.length} product(s) updated.`);
    }
  } catch (err) {
    console.error('Update failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

run();
