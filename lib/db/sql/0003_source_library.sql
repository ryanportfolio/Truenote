-- Source library: personal pins, notes and colors, team pins (featured),
-- nested categories with many-to-many membership, tags, and document view
-- events.
-- Read and written through raw SQL in routes/kb.ts and routes/kb-library.ts;
-- none of these tables are bound in Drizzle.
--
-- Program scoping is a security boundary. Every table carries program_id or
-- reaches it through documents.program_id, and the triggers at the end refuse
-- any row that would link objects from two different programs, so an API bug
-- cannot place a Program A document into a Program B category.

-- Personal state: one row per (user, document). A row exists while the user
-- has a pin, a note or a color; the API deletes it when all are cleared.
CREATE TABLE IF NOT EXISTS kb_source_user_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pinned_at timestamptz,
  note text,
  note_updated_at timestamptz,
  color text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id),
  CONSTRAINT kb_source_user_state_note_size_check
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 4000),
  CONSTRAINT kb_source_user_state_color_check
    CHECK (color IS NULL OR color = ANY (ARRAY['slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink']))
);

CREATE INDEX IF NOT EXISTS kb_source_user_state_document_idx
  ON kb_source_user_state (document_id);

-- Team pins: a manager+ pins a source for everyone in its program, in a
-- manager-chosen order.
CREATE TABLE IF NOT EXISTS kb_source_featured (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  featured_by uuid REFERENCES users(id) ON DELETE SET NULL,
  featured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_source_featured_program_idx
  ON kb_source_featured (program_id, position);

-- Categories nest through parent_id. Siblings are ordered by position.
-- Depth (max 4 levels) and cycle checks live in the trigger below.
CREATE TABLE IF NOT EXISTS kb_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES kb_categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'slate',
  position integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_categories_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT kb_categories_color_check
    CHECK (color = ANY (ARRAY['slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink'])),
  CONSTRAINT kb_categories_not_own_parent_check
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_categories_sibling_name_idx
  ON kb_categories (
    program_id,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

CREATE INDEX IF NOT EXISTS kb_categories_parent_idx
  ON kb_categories (program_id, parent_id, position);

-- A document can sit in any number of categories; position orders the
-- documents inside one category.
CREATE TABLE IF NOT EXISTS kb_category_documents (
  category_id uuid NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, document_id)
);

CREATE INDEX IF NOT EXISTS kb_category_documents_document_idx
  ON kb_category_documents (document_id);

-- Personal category color: overrides the team color in this user's view only.
CREATE TABLE IF NOT EXISTS kb_category_user_prefs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
  color text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category_id),
  CONSTRAINT kb_category_user_prefs_color_check
    CHECK (color = ANY (ARRAY['slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink']))
);

-- Personal names for colors ("Red: Read before quoting fees"), per user across programs.
CREATE TABLE IF NOT EXISTS kb_user_color_labels (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color text NOT NULL,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, color),
  CONSTRAINT kb_user_color_labels_color_check
    CHECK (color = ANY (ARRAY['slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink'])),
  CONSTRAINT kb_user_color_labels_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 40)
);

CREATE TABLE IF NOT EXISTS kb_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'slate',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_tags_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT kb_tags_color_check
    CHECK (color = ANY (ARRAY['slate', 'blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink']))
);

CREATE UNIQUE INDEX IF NOT EXISTS kb_tags_program_name_idx
  ON kb_tags (program_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS kb_document_tags (
  tag_id uuid NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, document_id)
);

CREATE INDEX IF NOT EXISTS kb_document_tags_document_idx
  ON kb_document_tags (document_id);

-- One row per document open in the reader. The API records at most one view
-- per user and document every 30 minutes, so counts track reads, not reloads.
CREATE TABLE IF NOT EXISTS kb_document_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via text NOT NULL DEFAULT 'browse',
  viewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_document_views_via_check
    CHECK (via = ANY (ARRAY['browse', 'citation']))
);

CREATE INDEX IF NOT EXISTS kb_document_views_program_time_idx
  ON kb_document_views (program_id, viewed_at DESC, document_id);

CREATE INDEX IF NOT EXISTS kb_document_views_user_document_idx
  ON kb_document_views (user_id, document_id, viewed_at DESC);

-- Citation counts on the Sources list and the source usage page read
-- query_log by program over a trailing window; the baseline has no index
-- for that.
CREATE INDEX IF NOT EXISTS query_log_program_created_idx
  ON query_log (program_id, created_at DESC);

-- Program consistency guards.

CREATE OR REPLACE FUNCTION kb_library_document_program(p_document_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT program_id FROM documents WHERE id = p_document_id
$$;

CREATE OR REPLACE FUNCTION kb_categories_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_program uuid;
  v_cursor uuid;
  v_depth integer := 1;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT program_id INTO v_parent_program FROM kb_categories WHERE id = NEW.parent_id;
  IF v_parent_program IS DISTINCT FROM NEW.program_id THEN
    RAISE EXCEPTION 'kb_categories: parent belongs to another program'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Walk up from the new parent. Meeting NEW.id means a cycle.
  v_cursor := NEW.parent_id;
  WHILE v_cursor IS NOT NULL LOOP
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'kb_categories: a category cannot be inside itself'
        USING ERRCODE = 'check_violation';
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 4 THEN
      RAISE EXCEPTION 'kb_categories: categories nest at most 4 levels'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO v_cursor FROM kb_categories WHERE id = v_cursor;
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kb_categories_guard_trg ON kb_categories;
CREATE TRIGGER kb_categories_guard_trg
  BEFORE INSERT OR UPDATE OF parent_id, program_id ON kb_categories
  FOR EACH ROW EXECUTE FUNCTION kb_categories_guard();

CREATE OR REPLACE FUNCTION kb_category_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT program_id FROM kb_categories WHERE id = NEW.category_id)
     IS DISTINCT FROM kb_library_document_program(NEW.document_id) THEN
    RAISE EXCEPTION 'kb_category_documents: category and document are in different programs'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kb_category_documents_guard_trg ON kb_category_documents;
CREATE TRIGGER kb_category_documents_guard_trg
  BEFORE INSERT OR UPDATE OF category_id, document_id ON kb_category_documents
  FOR EACH ROW EXECUTE FUNCTION kb_category_documents_guard();

CREATE OR REPLACE FUNCTION kb_document_tags_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT program_id FROM kb_tags WHERE id = NEW.tag_id)
     IS DISTINCT FROM kb_library_document_program(NEW.document_id) THEN
    RAISE EXCEPTION 'kb_document_tags: tag and document are in different programs'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kb_document_tags_guard_trg ON kb_document_tags;
CREATE TRIGGER kb_document_tags_guard_trg
  BEFORE INSERT OR UPDATE OF tag_id, document_id ON kb_document_tags
  FOR EACH ROW EXECUTE FUNCTION kb_document_tags_guard();

CREATE OR REPLACE FUNCTION kb_document_program_row_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.program_id IS DISTINCT FROM kb_library_document_program(NEW.document_id) THEN
    RAISE EXCEPTION '%: program_id does not match the document''s program', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kb_source_featured_guard_trg ON kb_source_featured;
CREATE TRIGGER kb_source_featured_guard_trg
  BEFORE INSERT OR UPDATE OF program_id, document_id ON kb_source_featured
  FOR EACH ROW EXECUTE FUNCTION kb_document_program_row_guard();

DROP TRIGGER IF EXISTS kb_document_views_guard_trg ON kb_document_views;
CREATE TRIGGER kb_document_views_guard_trg
  BEFORE INSERT OR UPDATE OF program_id, document_id ON kb_document_views
  FOR EACH ROW EXECUTE FUNCTION kb_document_program_row_guard();
