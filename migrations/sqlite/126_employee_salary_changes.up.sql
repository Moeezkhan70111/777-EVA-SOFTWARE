-- AN EMPLOYEE'S SALARY HISTORY (owner, 27 Nov 2026: "put a button in that card as increment. to increment the salary
-- by percentage or a fixed value").
--
--   employee_salary_changes   one line per change of an employee's monthly salary: the salary they were added with
--                             (START), and every increment (PERCENT or FIXED) with what was typed (hundredths of a
--                             percent, or paisa), the salary before and after in integer paisa, the day it counts from,
--                             a note, and who made it. Never changed or deleted: the salary on the employee is the last
--                             line, and the history shows how it got there.
--
-- A child of the EMPLOYEE record (local 124, cloud 044), so it travels inside it, written where the accounts are (PC1).
-- Every employee added before this gets a START line with the salary they have now, so no history begins empty.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS employee_salary_changes (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL,
  amount INTEGER,
  from_paisa INTEGER,
  to_paisa INTEGER NOT NULL,
  effective_on TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (kind IN ('START','PERCENT','FIXED')),
  CHECK (to_paisa > 0)
);

CREATE INDEX IF NOT EXISTS idx_employee_salary_changes_employee ON employee_salary_changes(employee_id, effective_on, created_at);

INSERT INTO employee_salary_changes (id, employee_id, kind, amount, from_paisa, to_paisa, effective_on, note, created_by, created_at)
SELECT 'start-' || e.id, e.id, 'START', NULL, NULL, e.monthly_salary_paisa, COALESCE(e.joined_on, substr(e.created_at, 1, 10)), NULL, e.created_by, e.created_at
FROM employees e
WHERE NOT EXISTS (SELECT 1 FROM employee_salary_changes c WHERE c.employee_id = e.id);
