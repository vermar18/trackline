CREATE TABLE image_uploads (
  upload_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part INT UNSIGNED NOT NULL,
  data MEDIUMTEXT CHARACTER SET ascii NOT NULL,
  expires BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (upload_id, username, part),
  INDEX uploads_expiry (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
