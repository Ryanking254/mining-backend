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
    `CREATE TABLE IF NOT EXISTS batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
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
      INDEX idx_batches_status (status),
      INDEX idx_batches_purchase_date (purchase_date)
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      batch_id INT NOT NULL,
      grams_sold DECIMAL(12,2) NOT NULL,
      selling_price_per_gram DECIMAL(12,2) NOT NULL,
      total_selling_price DECIMAL(14,2) NOT NULL,
      cost_basis DECIMAL(14,2) NOT NULL,
      profit_loss DECIMAL(14,2) NOT NULL,
      sale_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_sales_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
      INDEX idx_sales_batch (batch_id),
      INDEX idx_sales_date (sale_date)
    )`,
    `CREATE TABLE IF NOT EXISTS loans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      borrower_name VARCHAR(255) NOT NULL,
      amount_given DECIMAL(14,2) NOT NULL,
      amount_repaid DECIMAL(14,2) NOT NULL DEFAULT 0,
      date_given DATE NOT NULL,
      notes TEXT NULL,
      status ENUM('OPEN','PARTIAL','REPAID') NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_loans_status (status)
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
      amount DECIMAL(14,2) NOT NULL,
      category VARCHAR(128) NOT NULL,
      description TEXT NULL,
      expense_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exp_date (expense_date),
      INDEX idx_exp_category (category)
    )`,
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      amount DECIMAL(14,2) NOT NULL,
      reason VARCHAR(255) NULL,
      withdrawal_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wd_date (withdrawal_date)
    )`,
    `CREATE TABLE IF NOT EXISTS capital_settings (
      id INT PRIMARY KEY DEFAULT 1,
      starting_capital DECIMAL(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT chk_capital_single CHECK (id = 1)
    )`,
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
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_users_email (email)
    )`,
  ];
  for (const sql of ddl) {
    await pool.query(sql);
  }
  await pool.query(`INSERT IGNORE INTO capital_settings (id, starting_capital) VALUES (1, 0)`);

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
}
