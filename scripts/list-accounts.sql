\echo '=== organizations ==='
SELECT id, name, slug, is_platform, is_active FROM organizations ORDER BY id;

\echo '=== every non-learner account (admins + trainers) ==='
SELECT u.id, u.email, u.role, r.key AS role_key, u.is_active, o.slug AS org
  FROM users u
  JOIN organizations o ON o.id = u.organization_id
  LEFT JOIN roles r ON r.id = u.role_id
 WHERE u.role <> 'learner'
 ORDER BY o.id, u.id;

\echo '=== learner counts per organization ==='
SELECT o.slug, count(*) FILTER (WHERE u.role = 'learner') AS learners
  FROM organizations o LEFT JOIN users u ON u.organization_id = o.id
 GROUP BY o.slug, o.id ORDER BY o.id;

\echo '=== do these specific accounts exist? ==='
SELECT e.email,
       CASE WHEN u.id IS NULL THEN 'ABSENT' ELSE 'present (id ' || u.id || ')' END AS status,
       u.role, o.slug AS org, u.is_active
  FROM (VALUES ('admin@invensis.com'),('ravi.m@invensis.com'),
               ('admin@edstellar.com'),('sneha.k@edstellar.com'),
               ('trainer@edstellar.com'),('trainer.inv@invensis.com')) AS e(email)
  LEFT JOIN users u ON lower(u.email) = e.email
  LEFT JOIN organizations o ON o.id = u.organization_id
 ORDER BY e.email;
