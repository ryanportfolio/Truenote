-- Truenote document-review approval control
-- Application authorization limits approval to senior managers and super users.

ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_separation_check;
