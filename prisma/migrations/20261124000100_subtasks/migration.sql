ALTER TABLE items
  ADD COLUMN team VARCHAR(100) NOT NULL DEFAULT '',
  ADD COLUMN parent_id INT UNSIGNED NULL,
  ADD INDEX items_parent (parent_id, id),
  ADD CONSTRAINT items_parent_fk FOREIGN KEY (parent_id) REFERENCES items(id);

CREATE TABLE item_dependencies (
  item_id INT UNSIGNED NOT NULL,
  depends_on_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (item_id, depends_on_id),
  INDEX dependency_required (depends_on_id),
  CONSTRAINT dependency_item_fk FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT dependency_required_fk FOREIGN KEY (depends_on_id) REFERENCES items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
