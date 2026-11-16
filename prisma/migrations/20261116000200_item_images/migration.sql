CREATE TABLE item_images (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id INT UNSIGNED NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size INT UNSIGNED NOT NULL,
  data MEDIUMBLOB NOT NULL,
  created CHAR(24) NOT NULL,
  CONSTRAINT item_images_ibfk_1 FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  INDEX item_images_item (item_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
