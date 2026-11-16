CREATE TABLE items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, title VARCHAR(180) NOT NULL, type VARCHAR(16) NOT NULL,
  project VARCHAR(180) NOT NULL, owner VARCHAR(180) NOT NULL, status VARCHAR(16) NOT NULL,
  priority VARCHAR(16) NOT NULL, due VARCHAR(10) NOT NULL, description TEXT NOT NULL,
  resolution TEXT NOT NULL, created CHAR(24) NOT NULL, updated CHAR(24) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1, INDEX items_updated (updated, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, item_id INT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL, actor VARCHAR(180) NOT NULL, body MEDIUMTEXT NOT NULL,
  minutes INT UNSIGNED NOT NULL DEFAULT 0, at CHAR(24) NOT NULL,
  CONSTRAINT events_ibfk_1 FOREIGN KEY (item_id) REFERENCES items(id),
  INDEX events_item (item_id, id), INDEX events_recent (at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(100) NOT NULL, role ENUM('admin','member') NOT NULL,
  salt CHAR(32) NOT NULL, password_hash CHAR(128) NOT NULL, must_change BOOLEAN NOT NULL DEFAULT FALSE,
  admin_slot TINYINT GENERATED ALWAYS AS (IF(role = 'admin', 1, NULL)) STORED,
  UNIQUE KEY one_super_admin (admin_slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires BIGINT UNSIGNED NOT NULL,
  CONSTRAINT sessions_ibfk_1 FOREIGN KEY (username) REFERENCES users(username),
  INDEX username (username), INDEX sessions_expiry (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  attempt_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bucket BIGINT UNSIGNED NOT NULL, attempts INT UNSIGNED NOT NULL,
  PRIMARY KEY (attempt_key, bucket), INDEX attempts_expiry (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
