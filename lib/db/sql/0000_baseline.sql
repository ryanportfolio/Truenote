-- Baseline: the Truenote production schema (public) as it stood on Railway
-- on 2026-10-07, after the copy from Replit and before 0001. Schema only,
-- no data. Generated with:
--   pg_dump --schema-only --no-owner --no-acl --schema=public
--           --exclude-table=public.schema_migrations
-- It is recorded as applied in production's schema_migrations ledger and is
-- never applied there. Use it to build an empty database for local work:
--   psql -v ON_ERROR_STOP=1 -f lib/db/sql/0000_baseline.sql
--   psql -v ON_ERROR_STOP=1 -f lib/db/sql/0001_schema_migrations.sql (and later files)
-- Known gap (pre-existing, inherited from Replit): the SIEM outbox functions
-- and the security_events trigger from docs/security/p1-siem-delivery-outbox.sql
-- are absent; only the siem_delivery_outbox table exists.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg12+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'super_user',
    'senior_manager',
    'manager',
    'csr'
);

--
-- Name: append_security_event(text, text, uuid, text, text, uuid, text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_security_event(p_action text, p_outcome text, p_actor_user_id uuid, p_actor_email text, p_actor_role text, p_program_id uuid, p_resource_type text, p_resource_id text, p_request_id text, p_source_ip text, p_details jsonb) RETURNS TABLE(id uuid, occurred_at timestamp with time zone, event_hash text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := clock_timestamp();
  v_previous_hash text;
  v_event_hash text;
BEGIN
  IF p_action IS NULL OR p_action = '' THEN
    RAISE EXCEPTION 'security event action is required';
  END IF;

  IF p_outcome NOT IN ('success', 'denied', 'failure') THEN
    RAISE EXCEPTION 'security event outcome is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('truenote.security_events.hash_chain')
  );

  SELECT se.event_hash
  INTO v_previous_hash
  FROM security_events se
  ORDER BY se.sequence DESC
  LIMIT 1;

  v_event_hash := encode(
    digest(
      concat_ws(
        '|',
        COALESCE(v_previous_hash, ''),
        v_id::text,
        v_occurred_at::text,
        p_action,
        p_outcome,
        COALESCE(p_actor_user_id::text, ''),
        COALESCE(p_actor_email, ''),
        COALESCE(p_actor_role, ''),
        COALESCE(p_program_id::text, ''),
        COALESCE(p_resource_type, ''),
        COALESCE(p_resource_id, ''),
        COALESCE(p_request_id, ''),
        COALESCE(p_source_ip, ''),
        COALESCE(p_details, '{}'::jsonb)::text
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO security_events (
    id,
    occurred_at,
    action,
    outcome,
    actor_user_id,
    actor_email,
    actor_role,
    program_id,
    resource_type,
    resource_id,
    request_id,
    source_ip,
    details,
    previous_hash,
    event_hash
  )
  VALUES (
    v_id,
    v_occurred_at,
    p_action,
    p_outcome,
    p_actor_user_id,
    p_actor_email,
    p_actor_role,
    p_program_id,
    p_resource_type,
    p_resource_id,
    p_request_id,
    p_source_ip,
    COALESCE(p_details, '{}'::jsonb),
    v_previous_hash,
    v_event_hash
  );

  RETURN QUERY
  SELECT v_id, v_occurred_at, v_event_hash;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid NOT NULL,
    user_id text NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_version_id uuid,
    program_id uuid NOT NULL,
    ordinal integer,
    content text NOT NULL,
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    embedding public.vector(1536),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: content_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid NOT NULL,
    name text NOT NULL,
    origin_type text NOT NULL,
    base_uri text,
    owner_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    approval_basis text,
    retired_at timestamp with time zone,
    CONSTRAINT content_sources_approval_check CHECK (((is_active = false) OR ((approved_at IS NOT NULL) AND (owner_name <> ''::text)))),
    CONSTRAINT content_sources_origin_type_check CHECK ((origin_type = ANY (ARRAY['manual_upload'::text, 'sharepoint'::text, 'confluence'::text, 's3'::text, 'other'::text])))
);

--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    version_number integer NOT NULL,
    source_url text,
    mime_type text,
    file_sha256 text,
    parse_status text DEFAULT 'pending'::text,
    parsed_markdown text,
    uploaded_by text,
    uploaded_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    lifecycle_state text DEFAULT 'submitted'::text NOT NULL,
    classification text DEFAULT 'internal'::text NOT NULL,
    source_id uuid NOT NULL,
    source_origin_uri text,
    source_owner text NOT NULL,
    original_file_name text NOT NULL,
    scan_status text DEFAULT 'pending'::text NOT NULL,
    scan_engine text,
    scan_id text,
    scan_findings jsonb DEFAULT '[]'::jsonb NOT NULL,
    scan_completed_at timestamp with time zone,
    approved_by uuid,
    approved_at timestamp with time zone,
    approval_notes text,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    rejected_by uuid,
    rejected_at timestamp with time zone,
    rejection_reason text,
    revoked_by uuid,
    revoked_at timestamp with time zone,
    revocation_reason text,
    retention_until timestamp with time zone DEFAULT (now() + '365 days'::interval) NOT NULL,
    CONSTRAINT document_versions_active_control_check CHECK (((is_active = false) OR ((lifecycle_state = 'active'::text) AND (approved_at IS NOT NULL) AND (source_id IS NOT NULL) AND (scan_status = ANY (ARRAY['clean'::text, 'legacy_accepted'::text, 'disabled'::text]))))),
    CONSTRAINT document_versions_classification_check CHECK ((classification = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text, 'restricted'::text]))),
    CONSTRAINT document_versions_lifecycle_check CHECK ((lifecycle_state = ANY (ARRAY['submitted'::text, 'scanning'::text, 'parsing'::text, 'pending_review'::text, 'active'::text, 'retired'::text, 'quarantined'::text, 'rejected'::text, 'revoked'::text, 'failed'::text]))),
    CONSTRAINT document_versions_scan_status_check CHECK ((scan_status = ANY (ARRAY['pending'::text, 'running'::text, 'clean'::text, 'infected'::text, 'unavailable'::text, 'error'::text, 'legacy_accepted'::text, 'disabled'::text])))
);

--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid,
    title text NOT NULL,
    current_version_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    retired_at timestamp with time zone,
    retired_by uuid,
    retirement_reason text,
    CONSTRAINT documents_lifecycle_check CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'retired'::text])))
);

--
-- Name: error_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    severity text NOT NULL,
    source text NOT NULL,
    operation text NOT NULL,
    message text NOT NULL,
    name text,
    stack text,
    code text,
    status integer,
    provider text,
    model text,
    route_id text,
    request_id text,
    correlation_id text,
    method text,
    path text,
    user_id text,
    program_id uuid,
    query_log_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT error_log_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'error'::text, 'fatal'::text])))
);

--
-- Name: eval_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid,
    question text NOT NULL,
    expected_doc_id uuid,
    expected_answer_contains text[],
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid NOT NULL,
    requested_by uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    question_id uuid,
    judge boolean DEFAULT false NOT NULL,
    question_count integer DEFAULT 0 NOT NULL,
    completed_questions integer DEFAULT 0 NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    report jsonb,
    error text,
    is_baseline boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eval_runs_baseline_check CHECK (((NOT is_baseline) OR (status = 'completed'::text))),
    CONSTRAINT eval_runs_counts_check CHECK (((question_count >= 0) AND (completed_questions >= 0) AND (completed_questions <= question_count))),
    CONSTRAINT eval_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

--
-- Name: kb_highlights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_highlights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    document_version_id uuid NOT NULL,
    highlighted_text text NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    color text DEFAULT 'yellow'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_highlights_color_check CHECK ((color = ANY (ARRAY['yellow'::text, 'green'::text, 'blue'::text]))),
    CONSTRAINT kb_highlights_range_check CHECK (((start_offset >= 0) AND (end_offset > start_offset) AND ((end_offset - start_offset) <= 5000))),
    CONSTRAINT kb_highlights_text_size_check CHECK (((char_length(highlighted_text) >= 1) AND (char_length(highlighted_text) <= 5000)))
);

--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.query_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid,
    user_id text,
    question text NOT NULL,
    answer text,
    cited_chunk_ids uuid[],
    refused boolean DEFAULT false,
    latency_ms integer,
    feedback integer,
    created_at timestamp with time zone DEFAULT now(),
    flagged_missing boolean DEFAULT false NOT NULL,
    session_id uuid,
    timing_breakdown jsonb,
    citation_snapshots jsonb DEFAULT '[]'::jsonb NOT NULL
);

--
-- Name: security_control_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_control_metadata (
    key text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_events (
    sequence bigint NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL,
    actor_user_id uuid,
    actor_email text,
    actor_role text,
    program_id uuid,
    resource_type text,
    resource_id text,
    request_id text,
    source_ip text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    previous_hash text,
    event_hash text NOT NULL,
    CONSTRAINT security_events_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'denied'::text, 'failure'::text])))
);

--
-- Name: security_events_sequence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.security_events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.security_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: security_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_rate_limits (
    scope text NOT NULL,
    subject text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT security_rate_limits_request_count_check CHECK ((request_count > 0))
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_method text DEFAULT 'local'::text NOT NULL,
    auth_time timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sessions_auth_method_check CHECK ((auth_method = ANY (ARRAY['local'::text, 'oidc'::text])))
);

--
-- Name: siem_delivery_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.siem_delivery_outbox (
    security_event_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    delivered_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT siem_delivery_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT siem_delivery_outbox_lease_check CHECK ((((status = 'delivering'::text) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'delivering'::text) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT siem_delivery_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'dead_letter'::text]))),
    CONSTRAINT siem_delivery_outbox_terminal_check CHECK ((((status = 'delivered'::text) AND (delivered_at IS NOT NULL) AND (dead_lettered_at IS NULL) AND (next_attempt_at IS NULL)) OR ((status = 'dead_letter'::text) AND (delivered_at IS NULL) AND (dead_lettered_at IS NOT NULL) AND (next_attempt_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'delivering'::text])) AND (delivered_at IS NULL) AND (dead_lettered_at IS NULL) AND (next_attempt_at IS NOT NULL))))
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role public.user_role NOT NULL,
    program_id uuid,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_reset_password boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    max_classification text DEFAULT 'internal'::text NOT NULL,
    CONSTRAINT users_max_classification_check CHECK ((max_classification = ANY (ARRAY['public'::text, 'internal'::text, 'confidential'::text, 'restricted'::text]))),
    CONSTRAINT users_role_program_check CHECK ((((role = 'super_user'::public.user_role) AND (program_id IS NULL)) OR ((role <> 'super_user'::public.user_role) AND (program_id IS NOT NULL))))
);

--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);

--
-- Name: chat_sessions chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);

--
-- Name: chunks chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (id);

--
-- Name: content_sources content_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_sources
    ADD CONSTRAINT content_sources_pkey PRIMARY KEY (id);

--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);

--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

--
-- Name: error_log error_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_log
    ADD CONSTRAINT error_log_pkey PRIMARY KEY (id);

--
-- Name: eval_questions eval_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_questions
    ADD CONSTRAINT eval_questions_pkey PRIMARY KEY (id);

--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);

--
-- Name: kb_highlights kb_highlights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_highlights
    ADD CONSTRAINT kb_highlights_pkey PRIMARY KEY (id);

--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);

--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: programs programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_pkey PRIMARY KEY (id);

--
-- Name: query_log query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_log
    ADD CONSTRAINT query_log_pkey PRIMARY KEY (id);

--
-- Name: security_control_metadata security_control_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_control_metadata
    ADD CONSTRAINT security_control_metadata_pkey PRIMARY KEY (key);

--
-- Name: security_events security_events_event_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_event_hash_key UNIQUE (event_hash);

--
-- Name: security_events security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (id);

--
-- Name: security_events security_events_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_sequence_key UNIQUE (sequence);

--
-- Name: security_rate_limits security_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_rate_limits
    ADD CONSTRAINT security_rate_limits_pkey PRIMARY KEY (scope, subject, window_start);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

--
-- Name: siem_delivery_outbox siem_delivery_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.siem_delivery_outbox
    ADD CONSTRAINT siem_delivery_outbox_pkey PRIMARY KEY (security_event_id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: chat_sessions_user_program_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_sessions_user_program_idx ON public.chat_sessions USING btree (user_id, program_id);

--
-- Name: chunks_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_embedding_idx ON public.chunks USING hnsw (embedding public.vector_cosine_ops);

--
-- Name: chunks_program_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_program_idx ON public.chunks USING btree (program_id);

--
-- Name: chunks_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_tsv_idx ON public.chunks USING gin (content_tsv);

--
-- Name: content_sources_program_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_sources_program_active_idx ON public.content_sources USING btree (program_id, is_active, approved_at);

--
-- Name: content_sources_program_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX content_sources_program_name_uidx ON public.content_sources USING btree (program_id, lower(name));

--
-- Name: document_versions_classification_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_classification_active_idx ON public.document_versions USING btree (classification, document_id) WHERE ((is_active = true) AND (lifecycle_state = 'active'::text));

--
-- Name: document_versions_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_retention_idx ON public.document_versions USING btree (retention_until) WHERE (lifecycle_state = ANY (ARRAY['retired'::text, 'rejected'::text, 'revoked'::text]));

--
-- Name: document_versions_review_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_review_queue_idx ON public.document_versions USING btree (lifecycle_state, uploaded_at DESC) WHERE (lifecycle_state = ANY (ARRAY['pending_review'::text, 'quarantined'::text]));

--
-- Name: document_versions_sha_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_sha_idx ON public.document_versions USING btree (file_sha256);

--
-- Name: document_versions_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_source_idx ON public.document_versions USING btree (source_id);

--
-- Name: error_log_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX error_log_occurred_idx ON public.error_log USING btree (occurred_at DESC);

--
-- Name: error_log_source_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX error_log_source_occurred_idx ON public.error_log USING btree (source, occurred_at DESC);

--
-- Name: eval_questions_program_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_questions_program_id_idx ON public.eval_questions USING btree (program_id);

--
-- Name: eval_runs_program_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX eval_runs_program_active_uidx ON public.eval_runs USING btree (program_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

--
-- Name: eval_runs_program_baseline_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX eval_runs_program_baseline_uidx ON public.eval_runs USING btree (program_id) WHERE (is_baseline = true);

--
-- Name: eval_runs_program_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_runs_program_created_idx ON public.eval_runs USING btree (program_id, created_at DESC);

--
-- Name: kb_highlights_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_highlights_document_id_idx ON public.kb_highlights USING btree (document_id);

--
-- Name: kb_highlights_document_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_highlights_document_version_id_idx ON public.kb_highlights USING btree (document_version_id);

--
-- Name: kb_highlights_user_version_range_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_highlights_user_version_range_uidx ON public.kb_highlights USING btree (user_id, document_version_id, start_offset, end_offset);

--
-- Name: password_reset_tokens_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_expires_at_idx ON public.password_reset_tokens USING btree (expires_at);

--
-- Name: password_reset_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_user_id_idx ON public.password_reset_tokens USING btree (user_id);

--
-- Name: programs_name_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX programs_name_lower_uidx ON public.programs USING btree (lower(name));

--
-- Name: query_log_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX query_log_session_idx ON public.query_log USING btree (session_id);

--
-- Name: security_events_action_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_events_action_occurred_idx ON public.security_events USING btree (action, occurred_at DESC);

--
-- Name: security_events_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_events_occurred_idx ON public.security_events USING btree (occurred_at DESC);

--
-- Name: security_events_program_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_events_program_occurred_idx ON public.security_events USING btree (program_id, occurred_at DESC);

--
-- Name: security_rate_limits_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_rate_limits_expiry_idx ON public.security_rate_limits USING btree (expires_at);

--
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);

--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);

--
-- Name: siem_delivery_outbox_dead_letter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX siem_delivery_outbox_dead_letter_idx ON public.siem_delivery_outbox USING btree (dead_lettered_at DESC) WHERE (status = 'dead_letter'::text);

--
-- Name: siem_delivery_outbox_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX siem_delivery_outbox_due_idx ON public.siem_delivery_outbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'delivering'::text]));

--
-- Name: users_program_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_program_id_idx ON public.users USING btree (program_id);

--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role);

--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: chunks chunks_document_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id) ON DELETE CASCADE;

--
-- Name: content_sources content_sources_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_sources
    ADD CONSTRAINT content_sources_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: content_sources content_sources_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_sources
    ADD CONSTRAINT content_sources_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: content_sources content_sources_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_sources
    ADD CONSTRAINT content_sources_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE RESTRICT;

--
-- Name: document_versions document_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_versions document_versions_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: document_versions document_versions_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: document_versions document_versions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.content_sources(id) ON DELETE RESTRICT;

--
-- Name: documents documents_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE CASCADE;

--
-- Name: documents documents_retired_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: eval_runs eval_runs_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE CASCADE;

--
-- Name: eval_runs eval_runs_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.eval_questions(id) ON DELETE SET NULL;

--
-- Name: eval_runs eval_runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: kb_highlights kb_highlights_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_highlights
    ADD CONSTRAINT kb_highlights_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: kb_highlights kb_highlights_document_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_highlights
    ADD CONSTRAINT kb_highlights_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id) ON DELETE CASCADE;

--
-- Name: kb_highlights kb_highlights_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_highlights
    ADD CONSTRAINT kb_highlights_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: query_log query_log_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.query_log
    ADD CONSTRAINT query_log_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE SET NULL;

--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: siem_delivery_outbox siem_delivery_outbox_security_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.siem_delivery_outbox
    ADD CONSTRAINT siem_delivery_outbox_security_event_id_fkey FOREIGN KEY (security_event_id) REFERENCES public.security_events(id) ON DELETE RESTRICT;

--
-- Name: users users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: users users_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE RESTRICT;

--
-- PostgreSQL database dump complete
--
