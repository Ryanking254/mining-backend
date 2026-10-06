import mysql from 'mysql2/promise';

/**
 * TiDB Cloud is MySQL-protocol compatible.
 * Configure with either DATABASE_URL or discrete DB_* vars (see .env.example).
 * TiDB Cloud requires TLS -> set DB_SSL=true.
 */
function buildConfig() {
  if (process.env.DATABASE_URL) {
    return {
      uri: process.env.DATABASE_URL,
      ssl: { minVersion: 'TLSv1.2' },
    };
  }
  const sslEnabled = String(process.env.DB_SSL ?? 'false').toLowerCase() === 'true';
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mining_ledger',
    ssl: sslEnabled ? { minVersion: 'TLSv1.2' } : undefined,
  };
}

const cfg = buildConfig();

export const pool = cfg.uri
  ? mysql.createPool({
      uri: cfg.uri,
      ssl: cfg.ssl,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      dateStrings: true,
    })
  : mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Return DATE columns as 'YYYY-MM-DD' strings so the frontend date inputs work as-is.
      dateStrings: true,
    });

export async function pingDb() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

/** Create tables if they don't exist. Safe to run on every boot (incl. TiDB). */
export async function migrate() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      google_id VARCHAR(255) NULL UNIQUE,
      avatar_url TEXT NULL,
      twofa_secret VARCHAR(255) NULL,
      twofa_enabled TINYINT(1) NOT NULL DEFAULT 0,
      twofa_backup_codes TEXT NULL,
      twofa_exempt TINYINT(1) NOT NULL DEFAULT 0,
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      is_suspended TINYINT(1) NOT NULL DEFAULT 0,
      suspension_reason TEXT NULL,
      suspended_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_users_email (email)
    )`,
    `CREATE TABLE IF NOT EXISTS batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      batch_number VARCHAR(32) NOT NULL UNIQUE,
      item_name VARCHAR(255) NOT NULL,
      grams_bought DECIMAL(12,2) NOT NULL,
      grams_remaining DECIMAL(12,2) NOT NULL,
      price_per_gram DECIMAL(12,2) NOT NULL,
      total_cost DECIMAL(14,2) NOT NULL,
      purchase_date DATE NOT NULL,
      status ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_batches_user (user_id),
      INDEX idx_batches_status (status),
      INDEX idx_batches_purchase_date (purchase_date),
      CONSTRAINT fk_batches_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      batch_id INT NOT NULL,
      grams_taken DECIMAL(12,2) NULL,
      grams_sold DECIMAL(12,2) NOT NULL,
      purity_pct DECIMAL(5,2) NULL,
      selling_price_per_gram DECIMAL(12,2) NOT NULL,
      total_selling_price DECIMAL(14,2) NOT NULL,
      cost_basis DECIMAL(14,2) NOT NULL,
      profit_loss DECIMAL(14,2) NOT NULL,
      sale_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sales_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
      CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      INDEX idx_sales_user (user_id),
      INDEX idx_sales_batch (batch_id),
      INDEX idx_sales_date (sale_date)
    )`,
    `CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      borrower_name VARCHAR(255) NOT NULL,
      amount_given DECIMAL(14,2) NOT NULL,
      amount_repaid DECIMAL(14,2) NOT NULL DEFAULT 0,
      date_given DATE NOT NULL,
      notes TEXT NULL,
      status ENUM('OPEN','PARTIAL','REPAID') NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_loans_user (user_id),
      INDEX idx_loans_status (status),
      CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS loan_repayments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      loan_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      repaid_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_repay_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
      INDEX idx_repay_loan (loan_id)
    )`,
    `CREATE TABLE IF NOT EXISTS expenditures (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      amount DECIMAL(14,2) NOT NULL,
      category VARCHAR(128) NOT NULL,
      description TEXT NULL,
      expense_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exp_user (user_id),
      INDEX idx_exp_date (expense_date),
      INDEX idx_exp_category (category),
      CONSTRAINT fk_exp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      amount DECIMAL(14,2) NOT NULL,
      reason VARCHAR(255) NULL,
      withdrawal_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wd_user (user_id),
      INDEX idx_wd_date (withdrawal_date),
      CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS capital_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL UNIQUE,
      starting_capital DECIMAL(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_capital_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS capital_additions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      note VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_capadd_user (user_id),
      CONSTRAINT fk_capadd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
    // One row per batch consumed by a sale. Single-batch sales have 1 row;
    // combined multi-batch sales have N rows. sales.batch_id stays NOT NULL
    // as the primary (first) batch so legacy queries keep working.
    `CREATE TABLE IF NOT EXISTS sale_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sale_id INT NOT NULL,
      batch_id INT NOT NULL,
      grams_sold DECIMAL(12,2) NOT NULL,
      cost_basis DECIMAL(14,2) NOT NULL,
      CONSTRAINT fk_sb_sale FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE CASCADE,
      CONSTRAINT fk_sb_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
      INDEX idx_sb_sale (sale_id),
      INDEX idx_sb_batch (batch_id)
    )`,
    // 2FA disable requests — user asks to turn off the authenticator app, but
    // it stays ON until an admin approves. History rows stay for audit.
    `CREATE TABLE IF NOT EXISTS twofa_disable_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      reason VARCHAR(1000) NULL,
      admin_note VARCHAR(1000) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TIMESTAMP NULL,
      decided_by INT NULL,
      INDEX idx_tdr_user (user_id),
      INDEX idx_tdr_status (status),
      CONSTRAINT fk_tdr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`,
  ];
  for (const sql of ddl) {
    await pool.query(sql);
  }

  // Backfill: older DBs may lack total_cost (added for capital math). Add if missing.
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM batches LIKE 'total_cost'`);
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE batches ADD COLUMN total_cost DECIMAL(14,2) NOT NULL DEFAULT 0`);
      await pool.query(`UPDATE batches SET total_cost = grams_bought * price_per_gram WHERE total_cost = 0`);
    }
  } catch {
    /* ignore — fresh installs already have the column */
  }

  // Upgrade: per-account isolation — every ledger row belongs to a user.
  // Older DBs have no user_id columns; add them then attribute orphan rows
  // to the earliest account so existing single-user data doesn't disappear.
  const ownerTables = ['batches', 'sales', 'loans', 'expenditures', 'withdrawals'];
  for (const table of ownerTables) {
    try {
      const [existing] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'user_id'`);
      if (existing.length === 0) {
        await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN user_id INT NULL`);
      }
    } catch {
      /* ignore — best effort */
    }
  }
  // Sales burn columns: raw weight taken from the batch vs refined weight sold.
  try {
    const [existing] = await pool.query(`SHOW COLUMNS FROM sales LIKE 'grams_taken'`);
    if (existing.length === 0) {
      await pool.query(`ALTER TABLE sales ADD COLUMN grams_taken DECIMAL(12,2) NULL AFTER batch_id`);
      await pool.query(`UPDATE sales SET grams_taken = grams_sold WHERE grams_taken IS NULL`);
    }
  } catch {
    /* ignore — best effort */
  }
  // Sales purity: assay percentage after impurity removal (default 100 = pure).
  // Final amount = new weight × (purity / 100) × market price per gram.
  try {
    const [existing] = await pool.query(`SHOW COLUMNS FROM sales LIKE 'purity_pct'`);
    if (existing.length === 0) {
      await pool.query(`ALTER TABLE sales ADD COLUMN purity_pct DECIMAL(5,2) NULL AFTER grams_sold`);
      await pool.query(`UPDATE sales SET purity_pct = 100 WHERE purity_pct IS NULL`);
    }
  } catch {
    /* ignore — best effort */
  }
  // Multi-batch sales: one sale_batches row per batch consumed. Backfill
  // legacy single-batch sales so every sale has exactly its rows.
  try {
    await pool.query(
      `INSERT INTO sale_batches (sale_id, batch_id, grams_sold, cost_basis)
       SELECT s.id, s.batch_id, s.grams_sold, s.cost_basis FROM sales s
       WHERE s.id NOT IN (SELECT sale_id FROM sale_batches)`
    );
  } catch {
    /* ignore — best effort (empty sales table or FK state) */
  }
  // Attribute orphan ledger rows to the earliest user (keeps old data visible
  // to its owner instead of vanishing once queries are user-scoped).
  try {
    const [[first]] = await pool.query(`SELECT MIN(id) AS id FROM users`);
    if (first?.id) {
      const ownerId = first.id;
      // Sales inherit the owner of their parent batch first (most accurate).
      try {
        await pool.query(
          `UPDATE sales s JOIN batches b ON b.id = s.batch_id SET s.user_id = b.user_id WHERE s.user_id IS NULL AND b.user_id IS NOT NULL`
        );
      } catch { /* ignore */ }
      for (const table of ownerTables) {
        try {
          await pool.query(`UPDATE \`${table}\` SET user_id = ? WHERE user_id IS NULL`, [ownerId]);
        } catch { /* ignore */ }
      }
    }
  } catch {
    /* ignore — no users yet */
  }
  // Best-effort indexes + foreign keys for upgraded tables (fresh installs
  // already declare them inline; ignore duplicates).
  const fkStmts = [
    `ALTER TABLE batches ADD INDEX idx_batches_user (user_id)`,
    `ALTER TABLE sales ADD INDEX idx_sales_user (user_id)`,
    `ALTER TABLE loans ADD INDEX idx_loans_user (user_id)`,
    `ALTER TABLE expenditures ADD INDEX idx_exp_user (user_id)`,
    `ALTER TABLE withdrawals ADD INDEX idx_wd_user (user_id)`,
    `ALTER TABLE batches ADD CONSTRAINT fk_batches_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
    `ALTER TABLE sales ADD CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
    `ALTER TABLE loans ADD CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
    `ALTER TABLE expenditures ADD CONSTRAINT fk_exp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
    `ALTER TABLE withdrawals ADD CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
  ];
  for (const sql of fkStmts) {
    try {
      await pool.query(sql);
    } catch {
      /* ignore — already exists or incompatible state */
    }
  }

  // Upgrade: capital_settings from single global row (id = 1) to one row per user.
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM capital_settings LIKE 'user_id'`);
    if (cols.length === 0) {
      // Split in two: plain ADD COLUMN first (works everywhere), UNIQUE index
      // second (best-effort — the app's UPDATE-first logic works without it).
      // Previous single-statement `ADD COLUMN ... UNIQUE` failed silently on
      // some TiDB/privilege setups, leaving user_id missing and every
      // /api/capital call 500ing with "Unknown column 'user_id'".
      try {
        await pool.query(`ALTER TABLE capital_settings ADD COLUMN user_id INT NULL`);
      } catch (e) {
        console.error('[db] migrate warning: capital_settings ADD COLUMN user_id failed:', e.message);
        throw e;
      }
      try {
        await pool.query(`ALTER TABLE capital_settings ADD UNIQUE INDEX uq_capital_user (user_id)`);
      } catch (e) {
        console.error('[db] migrate warning: capital_settings ADD UNIQUE(user_id) failed (non-fatal):', e.message);
      }
    }
  } catch (e) {
    console.error('[db] migrate warning: capital_settings user_id upgrade skipped:', e?.message);
  }
  try {
    await pool.query(`ALTER TABLE capital_settings DROP CHECK chk_capital_single`);
  } catch (e) {
    /* ignore — may not exist */
  }
  try {
    // Old installs used `id INT PRIMARY KEY DEFAULT 1` (single global row).
    // Switch to AUTO_INCREMENT so each account can own its own row.
    await pool.query(`ALTER TABLE capital_settings MODIFY COLUMN id INT AUTO_INCREMENT PRIMARY KEY`);
  } catch (e) {
    console.error('[db] migrate warning: capital_settings id AUTO_INCREMENT conversion skipped:', e?.message);
  }
  try {
    // Old installs: single row id=1 with no owner -> give it to the first user.
    const [[first]] = await pool.query(`SELECT MIN(id) AS id FROM users`);
    if (first?.id) {
      await pool.query(`UPDATE capital_settings SET user_id = ? WHERE user_id IS NULL LIMIT 1`, [first.id]);
    }
  } catch {
    /* ignore */
  }
  try {
    await pool.query(`ALTER TABLE capital_settings ADD CONSTRAINT fk_capital_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`);
  } catch {
    /* ignore */
  }

  // Backfill: auth upgrades — Google OAuth + TOTP 2FA columns on users.
  // password_hash becomes nullable (Google-only accounts have no password).
  try {
    await pool.query(`ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL`);
  } catch {
    /* ignore */
  }
  const userCols = [
    ['google_id', 'google_id VARCHAR(255) NULL'],
    ['avatar_url', 'avatar_url TEXT NULL'],
    ['twofa_secret', 'twofa_secret VARCHAR(255) NULL'],
    ['twofa_enabled', 'twofa_enabled TINYINT(1) NOT NULL DEFAULT 0'],
    ['twofa_backup_codes', 'twofa_backup_codes TEXT NULL'],
    ['twofa_exempt', 'twofa_exempt TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_admin', 'is_admin TINYINT(1) NOT NULL DEFAULT 0'],
    ['is_suspended', 'is_suspended TINYINT(1) NOT NULL DEFAULT 0'],
    ['suspension_reason', 'suspension_reason TEXT NULL'],
    ['suspended_at', 'suspended_at TIMESTAMP NULL'],
  ];
  for (const [col, def] of userCols) {
    try {
      const [existing] = await pool.query(`SHOW COLUMNS FROM users LIKE ?`, [col]);
      if (existing.length === 0) {
        await pool.query(`ALTER TABLE users ADD COLUMN ${def}`);
      }
    } catch {
      /* ignore — best effort */
    }
  }
  // Unique index on google_id (allows multiple NULLs in MySQL/TiDB).
  try {
    const [idx] = await pool.query(`SHOW INDEX FROM users WHERE Key_name = 'uq_users_google_id'`);
    if (idx.length === 0) {
      await pool.query(`ALTER TABLE users ADD UNIQUE INDEX uq_users_google_id (google_id)`);
    }
  } catch {
    /* ignore — may already exist via UNIQUE column definition on fresh installs */
  }
  // Bootstrap admin: if ADMIN_EMAIL is set, promote matching accounts.
  // This is the supported way to make yourself the only admin — set it in
  // .env / Render env vars, then register (or log in) with that email.
  // Manual fallback: UPDATE users SET is_admin = 1 WHERE email = 'you@example.com';
  try {
    const adminEmails = String(process.env.ADMIN_EMAIL ?? process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.length > 0) {
      const placeholders = adminEmails.map(() => '?').join(',');
      await pool.query(
        `UPDATE users SET is_admin = 1 WHERE LOWER(email) IN (${placeholders})`,
        adminEmails
      );
    }
  } catch {
    /* ignore — best effort */
  }
}
