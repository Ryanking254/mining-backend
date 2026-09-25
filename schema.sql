-- Mining ledger schema — MySQL / TiDB Cloud compatible
-- Run manually if you prefer: mysql < schema.sql
-- (The server also auto-creates these tables on boot via CREATE TABLE IF NOT EXISTS.)

CREATE TABLE IF NOT EXISTS batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
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
  INDEX idx_batches_status (status),
  INDEX idx_batches_purchase_date (purchase_date)
);

CREATE TABLE IF NOT EXISTS sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  grams_sold DECIMAL(12, 2) NOT NULL,
  selling_price_per_gram DECIMAL(12, 2) NOT NULL,
  total_selling_price DECIMAL(14, 2) NOT NULL,
  cost_basis DECIMAL(14, 2) NOT NULL,
  profit_loss DECIMAL(14, 2) NOT NULL,
  sale_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sales_batch FOREIGN KEY (batch_id) REFERENCES batches (id),
  INDEX idx_sales_batch (batch_id),
  INDEX idx_sales_date (sale_date)
);

CREATE TABLE IF NOT EXISTS loans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  borrower_name VARCHAR(255) NOT NULL,
  amount_given DECIMAL(14, 2) NOT NULL,
  amount_repaid DECIMAL(14, 2) NOT NULL DEFAULT 0,
  date_given DATE NOT NULL,
  notes TEXT NULL,
  status ENUM('OPEN', 'PARTIAL', 'REPAID') NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_loans_status (status)
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
  amount DECIMAL(14, 2) NOT NULL,
  category VARCHAR(128) NOT NULL,
  description TEXT NULL,
  expense_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exp_date (expense_date),
  INDEX idx_exp_category (category)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  amount DECIMAL(14, 2) NOT NULL,
  reason VARCHAR(255) NULL,
  withdrawal_date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_wd_date (withdrawal_date)
);

-- Single-row table holding the owner's starting capital.
CREATE TABLE IF NOT EXISTS capital_settings (
  id INT PRIMARY KEY DEFAULT 1,
  starting_capital DECIMAL(14, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_capital_single CHECK (id = 1)
);

INSERT IGNORE INTO capital_settings (id, starting_capital) VALUES (1, 0);

-- Users: password login + Google OAuth + TOTP 2FA (Google Authenticator compatible).
-- password_hash is NULL for Google-only accounts; google_id links the Google identity.
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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_email (email)
);
