require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('../config/database');

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { name: 'MEAT',      color: '#dc2626' },
  { name: 'CHICKEN',   color: '#d97706' },
  { name: 'SAUSAGES',  color: '#ea580c' },
  { name: 'FISH',      color: '#2563eb' },
  { name: 'PORK',      color: '#db2777' },
  { name: 'POLONY',    color: '#7c3aed' },
  { name: 'TOAST',     color: '#ca8a04' },
  { name: 'ICE CREAM', color: '#0891b2' },
  { name: 'PET FOOD',  color: '#16a34a' },
  { name: 'OTHERS',    color: '#6b7280' },
];

// ── Products ──────────────────────────────────────────────────────────────────
// unit rule: code.length === 6 → 'kg', else → 'Pack'
const PRODUCTS = [
  { code: '000008',          name: 'BEEF HUNGARIAN SAUSAGE',    cost: 74,    sell: 91,  cat: 'SAUSAGES'  },
  { code: '000013',          name: 'BEEF LIVER',                cost: 90,    sell: 125, cat: 'MEAT'      },
  { code: '000023',          name: 'BEEF POLONY',               cost: 85,    sell: 99,  cat: 'POLONY'    },
  { code: '000037',          name: 'BEEF RIBS',                 cost: 0,     sell: 30,  cat: 'MEAT'      },
  { code: '000049',          name: 'BEEF SAUSAGE',              cost: 100,   sell: 125, cat: 'SAUSAGES'  },
  { code: '000019',          name: 'BOERWORES',                 cost: 0,     sell: 135, cat: 'SAUSAGES'  },
  { code: '826954',          name: 'BONES 15',                  cost: 75,    sell: 18,  cat: 'MEAT'      },
  { code: '000026',          name: 'BONES 20',                  cost: 75,    sell: 23,  cat: 'MEAT'      },
  { code: '6009881076061',   name: 'BRAAI PACK 1KG',            cost: 78,    sell: 88,  cat: 'CHICKEN'   },
  { code: '009802717233',    name: 'BRAAI PACK 750G',           cost: 0,     sell: 70,  cat: 'CHICKEN'   },
  { code: '5839238',         name: 'BREAK FAST MEAL 25KG',      cost: 0,     sell: 300, cat: 'OTHERS'    },
  { code: '000032',          name: 'BREAM FISH',                cost: 67,    sell: 78,  cat: 'FISH'      },
  { code: '000028',          name: 'BRISKET',                   cost: 0,     sell: 84,  cat: 'MEAT'      },
  { code: '000020',          name: 'CHAKALAKA',                 cost: 0,     sell: 55,  cat: 'SAUSAGES'  },
  { code: '5558734',         name: 'CHEESE POLONY TOAST',       cost: 0,     sell: 13,  cat: 'TOAST'     },
  { code: '6009802717257',   name: 'CHICK DRUMSTICKS 500G',     cost: 52,    sell: 62,  cat: 'CHICKEN'   },
  { code: '009802717271',    name: 'CHICK GIZZARDS 500G',       cost: 55,    sell: 62,  cat: 'CHICKEN'   },
  { code: '001490000062',    name: 'CHICK HEAD / FEET 1K',      cost: 42,    sell: 50,  cat: 'CHICKEN'   },
  { code: '009802717585',    name: 'CHICK HEARTS 500G',         cost: 27,    sell: 35,  cat: 'CHICKEN'   },
  { code: '009802717288',    name: 'CHICK LIVER 500G',          cost: 35,    sell: 42,  cat: 'CHICKEN'   },
  { code: '001490000109',    name: 'CHICK MALA 1K',             cost: 14,    sell: 15,  cat: 'CHICKEN'   },
  { code: '000010',          name: 'CHICK MIX PORTION',         cost: 78,    sell: 90,  cat: 'CHICKEN'   },
  { code: '001490000239',    name: 'CHICK MIX. PORTION 1.5K',   cost: 0,     sell: 135, cat: 'CHICKEN'   },
  { code: '001490000178',    name: 'CHICK MIX. PORTION 1K',     cost: 0,     sell: 90,  cat: 'CHICKEN'   },
  { code: '001490000222',    name: 'CHICK MIX. PORTION 5K',     cost: 0,     sell: 450, cat: 'CHICKEN'   },
  { code: '001490000024',    name: 'CHICK MIX. PORTION 2KG',    cost: 0,     sell: 180, cat: 'CHICKEN'   },
  { code: '001490000086',    name: 'CHICK NECK',                cost: 0,     sell: 50,  cat: 'CHICKEN'   },
  { code: '6009802717325',   name: 'CHICK THIGHS 500G',         cost: 45,    sell: 55,  cat: 'CHICKEN'   },
  { code: '009802717127',    name: 'CHICKEN FILLET 1KG',        cost: 0,     sell: 135, cat: 'CHICKEN'   },
  { code: '000009',          name: 'CHICKEN HUNGARIAN SAUSAGE', cost: 74,    sell: 91,  cat: 'SAUSAGES'  },
  { code: '009802717042',    name: 'CHICKEN WINGS 1KG',         cost: 0,     sell: 140, cat: 'CHICKEN'   },
  { code: '972470265316',    name: 'CHOC CONE',                 cost: 15,    sell: 18,  cat: 'ICE CREAM' },
  { code: '972470265293',    name: 'CHOCOLATE CRISP',           cost: 15,    sell: 17,  cat: 'ICE CREAM' },
  { code: '000027',          name: 'CHUCK',                     cost: 0,     sell: 86,  cat: 'MEAT'      },
  { code: '6009706160500',   name: 'COOKING OIL 2 LITRE',       cost: 0,     sell: 120, cat: 'OTHERS'    },
  { code: '6009706160517',   name: 'COOKING OIL 2.5 LT',        cost: 0,     sell: 130, cat: 'OTHERS'    },
  { code: '6972470265439',   name: 'DRIPPING CHOCOLATE',        cost: 0,     sell: 18,  cat: 'ICE CREAM' },
  { code: '6575262',         name: 'EGG',                       cost: 80,    sell: 90,  cat: 'OTHERS'    },
  { code: '000052',          name: 'FILLET',                    cost: 75,    sell: 140, cat: 'MEAT'      },
  { code: '000060',          name: 'GOAT MEAT',                 cost: 0,     sell: 105, cat: 'MEAT'      },
  { code: '000016',          name: 'HOOVES',                    cost: 0,     sell: 70,  cat: 'MEAT'      },
  { code: '000021',          name: 'KIDNEY',                    cost: 0,     sell: 98,  cat: 'MEAT'      },
  { code: '000014',          name: 'MACKEREL FISH',             cost: 0,     sell: 50,  cat: 'FISH'      },
  { code: '972470265309',    name: 'MAIZE CONE',                cost: 10,    sell: 13,  cat: 'ICE CREAM' },
  { code: '7263978',         name: 'MEALING MEAL 5KG',          cost: 0,     sell: 60,  cat: 'OTHERS'    },
  { code: '000044',          name: 'MEAT BALLS',                cost: 0,     sell: 99,  cat: 'MEAT'      },
  { code: '6009888701478',   name: 'MILK 225 ML',               cost: 6,     sell: 9,   cat: 'OTHERS'    },
  { code: '6009888701348',   name: 'MILK 475 ML',               cost: 11.80, sell: 15,  cat: 'OTHERS'    },
  { code: '000002',          name: 'MINCE MEAT',                cost: 75,    sell: 120, cat: 'MEAT'      },
  { code: '000001',          name: 'MIXED CUTS',                cost: 75,    sell: 90,  cat: 'MEAT'      },
  { code: '000029',          name: 'NECK',                      cost: 0,     sell: 84,  cat: 'MEAT'      },
  { code: '000015',          name: 'OX-TAIL',                   cost: 0,     sell: 94,  cat: 'MEAT'      },
  { code: '000055',          name: 'PAULA FISH',                cost: 0,     sell: 85,  cat: 'FISH'      },
  { code: '000006',          name: 'PET FOOD',                  cost: 0,     sell: 15,  cat: 'PET FOOD'  },
  { code: '000012',          name: 'POLONY TOAST',              cost: 0,     sell: 85,  cat: 'TOAST'     },
  { code: '000024',          name: 'PORK CHOPS',                cost: 0,     sell: 120, cat: 'PORK'      },
  { code: '000022',          name: 'PORK NECK',                 cost: 0,     sell: 90,  cat: 'PORK'      },
  { code: '000018',          name: 'PORK POLONY',               cost: 0,     sell: 117, cat: 'POLONY'    },
  { code: '000031',          name: 'PORK RIBS',                 cost: 0,     sell: 100, cat: 'PORK'      },
  { code: '000030',          name: 'PORK TROTTERS',             cost: 0,     sell: 50,  cat: 'PORK'      },
  { code: '000033',          name: 'RUMP STEAK',                cost: 0,     sell: 115, cat: 'MEAT'      },
  { code: '000017',          name: 'SALAMI POLONY',             cost: 0,     sell: 145, cat: 'POLONY'    },
  { code: '000004',          name: 'SHIN',                      cost: 75,    sell: 83,  cat: 'MEAT'      },
  { code: '000007',          name: 'SHOULDER',                  cost: 0,     sell: 116, cat: 'MEAT'      },
  { code: '001490000208',    name: 'SOUP PACK 1KG',             cost: 0,     sell: 60,  cat: 'CHICKEN'   },
  { code: '000025',          name: 'SPICE MINCE',               cost: 0,     sell: 50,  cat: 'MEAT'      },
  { code: '000056',          name: 'STEAK',                     cost: 75,    sell: 130, cat: 'MEAT'      },
  { code: '000003',          name: 'STEAK ON BONE',             cost: 75,    sell: 114, cat: 'MEAT'      },
  { code: '6972470265453',   name: 'SUPER ORANGE',              cost: 10,    sell: 13,  cat: 'ICE CREAM' },
  { code: '000005',          name: 'T-BONE',                    cost: 75,    sell: 114, cat: 'MEAT'      },
  { code: '6972470265408',   name: 'TANGO MANGO',               cost: 10,    sell: 13,  cat: 'ICE CREAM' },
  { code: '972470260007',    name: 'VANILLA CUP',               cost: 10,    sell: 15,  cat: 'ICE CREAM' },
  { code: '69888590',        name: 'WHOLE CHICKEN - FROZEN',    cost: 0,     sell: 140, cat: 'CHICKEN'   },
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Starting seed...\n');
    await client.query('BEGIN');

    // ── 1. Insert categories (skip if already exists) ──────────────────────
    console.log('Inserting categories...');
    const catMap = {}; // name → id

    for (const cat of CATEGORIES) {
      // Check if already exists
      const exists = await client.query('SELECT id FROM categories WHERE name = $1', [cat.name]);
      if (exists.rows.length > 0) {
        catMap[cat.name] = exists.rows[0].id;
        console.log(`  SKIP category "${cat.name}" (already exists, id=${exists.rows[0].id})`);
      } else {
        const res = await client.query(
          'INSERT INTO categories (name, color) VALUES ($1, $2) RETURNING id',
          [cat.name, cat.color]
        );
        catMap[cat.name] = res.rows[0].id;
        console.log(`  ADDED category "${cat.name}" → id=${res.rows[0].id}`);
      }
    }

    // ── 2. Insert products (skip if code already exists) ───────────────────
    console.log('\nInserting products...');
    let added = 0, skipped = 0;

    for (const p of PRODUCTS) {
      const unit = p.code.length === 6 ? 'kg' : 'Pack';
      const categoryId = catMap[p.cat] || null;

      const exists = await client.query('SELECT id FROM products WHERE code = $1', [p.code]);
      if (exists.rows.length > 0) {
        console.log(`  SKIP "${p.name}" (code ${p.code} already exists)`);
        skipped++;
        continue;
      }

      const res = await client.query(
        `INSERT INTO products (code, name, category_id, unit, cost_price, selling_price, current_stock, min_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [p.code, p.name, categoryId, unit, p.cost, p.sell, 50, 5]
      );

      // Add opening stock movement
      await client.query(
        `INSERT INTO stock_movements (product_id, location, movement_type, quantity, notes)
         VALUES ($1, 'store', 'opening', 50, 'Opening balance - seeded')`,
        [res.rows[0].id]
      );

      console.log(`  ADDED "${p.name}" [${unit}] cat=${p.cat}`);
      added++;
    }

    await client.query('COMMIT');
    console.log(`\n✓ Done! ${added} products added, ${skipped} skipped.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
