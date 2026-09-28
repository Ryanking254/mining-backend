-- Mining ledger schema — MySQL / TiDB Cloud compatible
-- Run manually if you prefer: mysql < schema.sql
-- (The server also auto-creates these tables on boot via CREATE TABLE IF NOT EXISTS.)
--
-- Isolation rule: EVERY ledger row belongs to exactly one account via user_id.
-- All data endpoints filter by the signed-in user's id, so one account can
-- never see another account's batches, sales, loans, expenses or withdrawals.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  google_id VARCHAR(255) NULL UNIQUE,
  avatar_url TEXT NULL,
  twofa_secret VARCHAR(255) NULL,
  twofa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  twofa_backup_codes TEXT NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  is_suspended TINYINT(1) NOT NULL DEFAULT 0,
  suspension_reason TEXT NULL,
  suspended_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_email (email)
);

CREATE TABLE IF NOT EXISTS batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  batch_number VARCHAR(32) NOT NULL UNIQUE,
  item_name VARCHAR(255) NOT NULL,
  grams_bought DECIMAL(12, 2) NOT NULL,
  grams_remaining DECIMAL(12, 2) NOT NULL,
  price_per_gram DECIMAL(12, 2) NOT NULL,
  total_cost DECIMAL(14, 2) NOT NULL,
  purchase_date DATE NOT NULL,
  status ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_batches_user (user_id),
  INDEX idx_batches_status (status),
  INDEX idx_batches_purchase_date (purchase_date),
  CONSTRAINT fk_batches_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  batch_id INT NOT NULL,
  -- Burn handling: grams_taken = raw weight removed from the batch (legacy);
  -- grams_sold = NEW weight after burning / impurity removal.
  -- purity_pct = assay % after impurity removal; total = weight × % × price.
  grams_taken DECIMAL(12, 2) NULL,
  grams_sold DECIMAL(12, 2) NOT NULL,
  purity_pct DECIMAL(5, 2) NULL,
  selling_price_per_gram DECIMAL(12, 2) NOT NULL,
  total_selling_price DECIMAL(14, 2) NOT NULL,
  cost_basis DECIMAL(14, 2) NOT NULL,
  profit_loss DECIMAL(14, 2) NOT NULL,
  sale_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sales_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
  CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  INDEX idx_sales_user (user_id),
  INDEX idx_sales_batch (batch_id),
  INDEX idx_sales_date (sale_date)
);

-- One row per batch consumed by a sale (multi-batch sales).
-- sales.batch_id stays the primary (first) batch for backwards compatibility.
CREATE TABLE IF NOT EXISTS sale_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  batch_id INT NOT NULL,
  grams_sold DECIMAL(12, 2) NOT NULL,
  cost_basis DECIMAL(14, 2) NOT NULL,
  CONSTRAINT fk_sb_sale FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE CASCADE,
  CONSTRAINT fk_sb_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
  INDEX idx_sb_sale (sale_id),
  INDEX idx_sb_batch (batch_id)
);

CREATE TABLE IF NOT EXISTS loans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  borrower_name VARCHAR(255) NOT NULL,
  amount_given DECIMAL(14, 2) NOT NULL,
  amount_repaid DECIMAL(14, 2) NOT NULL DEFAULT 0,
  date_given DATE NOT NULL,
  notes TEXT NULL,
  status ENUM('OPEN', 'PARTIAL', 'REPAID') NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_loans_user (user_id),
  INDEX idx_loans_status (status),
  CONSTRAINT fk_loans_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loan_repayments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  loan_id INT NOT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  repaid_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_repay_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
  INDEX idx_repay_loan (loan_id)
);

CREATE TABLE IF NOT EXISTS expenditures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  category VARCHAR(128) NOT NULL,
  description TEXT NULL,
  expense_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exp_user (user_id),
  INDEX idx_exp_date (expense_date),
  INDEX idx_exp_category (category),
  CONSTRAINT fk_exp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  reason VARCHAR(255) NULL,
  withdrawal_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_wd_user (user_id),
  INDEX idx_wd_date (withdrawal_date),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- One row per account holding that account's starting capital.
CREATE TABLE IF NOT EXISTS capital_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL UNIQUE,
  starting_capital DECIMAL(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_capital_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Manual top-ups to the current capital (extra cash injected). Auditable history;
-- GET /api/capital adds SUM(amount) to the starting capital.
CREATE TABLE IF NOT EXISTS capital_additions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_capadd_user (user_id),
  CONSTRAINT fk_capadd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
