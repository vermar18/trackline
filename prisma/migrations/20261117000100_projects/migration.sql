CREATE TABLE projects (
  name VARCHAR(180) PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO projects (name)
SELECT MIN(project) FROM items WHERE project <> '' GROUP BY project;
