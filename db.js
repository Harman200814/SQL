// PostgreSQL database layer for production.
// Set DATABASE_URL in Render (and locally for development).
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Create a PostgreSQL database and set DATABASE_URL.');
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

function q(text, params = []) { return pool.query(text, params); }

async function initDatabase() {
  await q(`
    CREATE TABLE IF NOT EXISTS hospitals (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      phone TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS antivenoms (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory (
      hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
      antivenom_id BIGINT NOT NULL REFERENCES antivenoms(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      available BOOLEAN NOT NULL DEFAULT FALSE,
      last_updated TIMESTAMPTZ,
      PRIMARY KEY (hospital_id, antivenom_id)
    );

    CREATE TABLE IF NOT EXISTS bite_reports (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ai_species TEXT,
      ai_category TEXT,
      ai_confidence INTEGER,
      user_lat DOUBLE PRECISION,
      user_lng DOUBLE PRECISION,
      notes TEXT,
      contact_phone TEXT
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id BIGSERIAL PRIMARY KEY,
      hospital_id BIGINT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      specialty TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_hospitals_status ON hospitals(status);
    CREATE INDEX IF NOT EXISTS idx_inventory_hospital ON inventory(hospital_id);
    CREATE INDEX IF NOT EXISTS idx_doctors_hospital ON doctors(hospital_id);
  `);

  const antivenoms = [
    ['Polyvalent ASV — Cobra group', 'Cobra'],
    ['Polyvalent ASV — Krait group', 'Krait'],
    ['Polyvalent ASV — Viper group', 'Viper'],
    ['King Cobra monovalent ASV', 'KingCobra'],
    ['Pit Viper / supportive ASV stock', 'PitViper'],
  ];
  for (const [name, category] of antivenoms) {
    await q(`INSERT INTO antivenoms (name, category) VALUES ($1, $2) ON CONFLICT (category) DO NOTHING`, [name, category]);
  }

  // Ensure inventory rows exist for every hospital/antivenom pair.
  await q(`
    INSERT INTO inventory (hospital_id, antivenom_id, quantity, available, last_updated)
    SELECT h.id, a.id, 0, FALSE, NOW()
    FROM hospitals h CROSS JOIN antivenoms a
    ON CONFLICT (hospital_id, antivenom_id) DO NOTHING
  `);

  // Demo data is NEVER seeded automatically in production.
  if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production') {
    await seedDemoData();
  }
}

async function seedDemoData() {
  const { rows } = await q('SELECT COUNT(*)::int AS c FROM hospitals');
  if (rows[0].c > 0) return;

  const demoHash = bcrypt.hashSync('demo1234', 12);
  const antivenomRows = (await q('SELECT id, category FROM antivenoms')).rows;
  const antivenomIds = Object.fromEntries(antivenomRows.map(r => [r.category, r.id]));

  const demoHospitals = [
    ['Government Hospital (Demo)', 'Civil Lines, Ludhiana', 30.9010, 75.8573, '+911615550101', 'govt.hospital@demo.local', { Cobra:[12,1,-10], Krait:[8,1,-10], Viper:[5,1,-400], KingCobra:[2,1,-30], PitViper:[4,1,-60] }],
    ['City Medical Centre (Demo)', 'Model Town, Ludhiana', 30.9130, 75.8480, '+911615550102', 'city.medical@demo.local', { Cobra:[7,1,-20], Krait:[0,0,-1100], Viper:[3,1,-20], KingCobra:[0,0,-2000], PitViper:[2,1,-40] }],
    ['Community Health Centre (Demo)', 'Ferozepur Road, Ludhiana', 30.8700, 75.8200, '+911615550103', 'chc.ferozepur@demo.local', { Cobra:[0,0,-3000], Krait:[6,1,-60], Viper:[0,0,-3000], KingCobra:[1,1,-120], PitViper:[0,0,-3000] }],
    ['District Hospital (Demo)', 'Sarabha Nagar, Ludhiana', 30.8950, 75.8100, '+911615550104', 'district.hospital@demo.local', { Cobra:[4,1,-90], Krait:[4,1,-90], Viper:[9,1,-90], KingCobra:[0,0,-500], PitViper:[5,1,-50] }],
  ];

  for (const [name,address,lat,lng,phone,email,stock] of demoHospitals) {
    const hospital = (await q(`INSERT INTO hospitals (name,address,lat,lng,phone,email,password_hash,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'approved') RETURNING id`, [name,address,lat,lng,phone,email,demoHash])).rows[0];
    for (const [category, [quantity, available, minsAgo]] of Object.entries(stock)) {
      await q(`UPDATE inventory SET quantity=$1, available=$2, last_updated=$3 WHERE hospital_id=$4 AND antivenom_id=$5`, [quantity, !!available, new Date(Date.now() + minsAgo * 60000), hospital.id, antivenomIds[category]]);
    }
  }
  const hospitals = (await q('SELECT id FROM hospitals ORDER BY id LIMIT 2')).rows;
  if (hospitals.length >= 2) {
    await q(`INSERT INTO doctors (hospital_id,name,specialty,phone) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)`, [hospitals[0].id,'Dr. A. Sharma (Demo)','Emergency Medicine','+911615550111',hospitals[1].id,'Dr. R. Kaur (Demo)','Toxicology','+911615550112']);
  }
  console.log('Seeded development demo database with 4 hospitals.');
}

async function close() { await pool.end(); }

module.exports = { q, pool, initDatabase, close };
