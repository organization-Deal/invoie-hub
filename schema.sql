PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS google_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('gmail_source','drive_storage')),
  refresh_token_enc TEXT NOT NULL,
  scope TEXT,
  last_sync_at TEXT,
  history_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email, account_type)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('gmail_source','drive_storage')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drive_folders (
  path TEXT PRIMARY KEY,
  drive_folder_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  messages_scanned INTEGER NOT NULL DEFAULT 0,
  documents_added INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY(account_id) REFERENCES google_accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id INTEGER NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  gmail_attachment_id TEXT NOT NULL,
  subject TEXT,
  sender TEXT,
  received_at TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  vendor TEXT,
  invoice_number TEXT,
  document_date TEXT,
  amount REAL,
  currency TEXT,
  vat_amount REAL,
  drive_file_id TEXT,
  drive_web_view_link TEXT,
  drive_path TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review','reviewed','sent_to_accounting','ignored')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(source_account_id) REFERENCES google_accounts(id) ON DELETE CASCADE,
  UNIQUE(source_account_id, gmail_message_id, gmail_attachment_id),
  UNIQUE(sha256)
);

CREATE INDEX IF NOT EXISTS idx_documents_received_at ON documents(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_vendor ON documents(vendor);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON google_accounts(is_active, account_type);
