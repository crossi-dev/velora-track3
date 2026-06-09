-- Canonicalize AR phones stored under the old normalizePhone bug.
-- The pre-libphonenumber-js normalizer prepended "+549" to numbers that still
-- carried the trunk "0" (e.g. "02612..."), producing the invalid "+5490..." form.
-- AR mobile E.164 never has a 0 right after +549, so "+5490<digit>" is unambiguously
-- the buggy form. Strip the spurious 0 so these rows match the new normalizer output.
-- Idempotent: re-running matches nothing once fixed. Targeted: only "+5490" rows.
-- Standard refs: libphonenumber-js (E.164) https://github.com/catamphetamine/libphonenumber-js
--                Postgres UPDATE https://www.postgresql.org/docs/current/sql-update.html
UPDATE "Customer"
   SET phone = '+549' || substring(phone from 6)
 WHERE phone LIKE '+5490%';
