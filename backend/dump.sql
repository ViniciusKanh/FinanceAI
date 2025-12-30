PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      bank TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
INSERT INTO accounts VALUES(1,'Carteira','Pessoal','carteira','2025-12-30T12:00:48Z');
INSERT INTO accounts VALUES(2,'Nubank','Nubank','corrente','2025-12-30T12:01:32Z');
CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
INSERT INTO categories VALUES(1,'Alimentação','2025-12-30T12:00:48Z');
INSERT INTO categories VALUES(2,'Transporte','2025-12-30T12:00:48Z');
INSERT INTO categories VALUES(3,'Lazer','2025-12-30T12:00:48Z');
INSERT INTO categories VALUES(4,'Contas Fixas','2025-12-30T12:00:48Z');
INSERT INTO categories VALUES(5,'Salário','2025-12-30T12:00:48Z');
INSERT INTO categories VALUES(6,'Cartão de Crédito','2025-12-30T12:04:28Z');
INSERT INTO categories VALUES(7,'Eletrônico','2025-12-30T12:29:44Z');
INSERT INTO categories VALUES(8,'Entretenimento','2025-12-30T12:29:57Z');
INSERT INTO categories VALUES(9,'Beneficio','2025-12-30T12:38:05Z');
INSERT INTO categories VALUES(10,'Moradia','2025-12-30T12:38:58Z');
CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      amount REAL NOT NULL CHECK(amount >= 0),
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
INSERT INTO transactions VALUES(6,'income',2800.0,'Salario','2026-01-07',2,'Salário','2025-12-30T12:14:34Z');
INSERT INTO transactions VALUES(11,'income',1764.72000000000002,'Decimo Terceiro','2026-01-02',2,'Beneficio','2025-12-30T12:38:27Z');
INSERT INTO transactions VALUES(13,'expense',720.0,'Aluguel','2026-01-07',2,'Moradia','2025-12-30T12:39:44Z');
INSERT INTO transactions VALUES(14,'expense',80.0,'Internet','2026-01-10',2,'Contas Fixas','2025-12-30T12:40:14Z');
CREATE TABLE credit_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      bank TEXT NOT NULL,
      closing_day INTEGER NOT NULL CHECK(closing_day BETWEEN 1 AND 31),
      due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
      credit_limit REAL DEFAULT 0 CHECK(credit_limit >= 0),
      created_at TEXT NOT NULL
    );
INSERT INTO credit_cards VALUES(1,'Nubank Platinum','Nubank',5,12,7500.0,'2025-12-30T12:25:37Z');
CREATE TABLE card_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK(amount >= 0),
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      purchase_date TEXT NOT NULL,        -- YYYY-MM-DD
      invoice_ym TEXT NOT NULL,           -- YYYY-MM
      status TEXT NOT NULL CHECK(status IN ('pending','paid')) DEFAULT 'pending',
      paid_at TEXT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(card_id) REFERENCES credit_cards(id) ON DELETE CASCADE
    );
INSERT INTO card_purchases VALUES(1,1,200.0,'Saideira com Meninas','Lazer','2025-12-06','2026-01','pending',NULL,'2025-12-30T12:26:56Z');
INSERT INTO card_purchases VALUES(2,1,82.8599999999999994,'Fone de Ouvido','Lazer','2025-12-11','2026-01','pending',NULL,'2025-12-30T12:29:27Z');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('accounts',2);
INSERT INTO sqlite_sequence VALUES('categories',10);
INSERT INTO sqlite_sequence VALUES('transactions',14);
INSERT INTO sqlite_sequence VALUES('credit_cards',1);
INSERT INTO sqlite_sequence VALUES('card_purchases',2);
CREATE INDEX idx_tx_date ON transactions(date);
CREATE INDEX idx_tx_account ON transactions(account_id);
CREATE INDEX idx_card_purchases_invoice ON card_purchases(card_id, invoice_ym);
CREATE INDEX idx_card_purchases_date ON card_purchases(purchase_date);
COMMIT;
