-- Supervisor role: ranks between csr and manager (ROLE_RANK in
-- artifacts/api-server/src/lib/auth/current-user.ts). A supervisor has a
-- program like every role below super_user, so users_role_program_check needs
-- no change. The enum lists roles most to least privileged and the users list
-- sorts by role, so the value goes between manager and csr (BEFORE 'csr').
--
-- A file of its own because Postgres cannot use an enum value in the
-- transaction that adds it; 0005_team_members.sql compares against
-- 'supervisor' and runs in a later transaction.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'supervisor' BEFORE 'csr';
