-- ============================================================
-- Scientific Proposal Validator — Supabase Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. PROJECTS TABLE
CREATE TABLE IF NOT EXISTS projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        TEXT NOT NULL,
  iin              TEXT NOT NULL,
  whatsapp         TEXT NOT NULL,
  project_name     TEXT NOT NULL,
  description      TEXT,
  file_url         TEXT,
  parsed_text      TEXT,
  ai_summary       TEXT,
  ai_analysis      JSONB,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for faster status queries
CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);

-- 2. ROW LEVEL SECURITY
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Allow anon key full access (for demo; tighten in production)
DROP POLICY IF EXISTS "anon_select" ON projects;
DROP POLICY IF EXISTS "anon_insert" ON projects;
DROP POLICY IF EXISTS "anon_update" ON projects;

CREATE POLICY "anon_select" ON projects FOR SELECT USING (true);
CREATE POLICY "anon_insert" ON projects FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_update" ON projects FOR UPDATE USING (true) WITH CHECK (true);

-- 3. STORAGE BUCKET
-- Create the bucket (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'proposals',
  'proposals',
  true,
  20971520,                                    -- 20 MB
  ARRAY['application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
DROP POLICY IF EXISTS "proposals_insert" ON storage.objects;
DROP POLICY IF EXISTS "proposals_select" ON storage.objects;

CREATE POLICY "proposals_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'proposals');

CREATE POLICY "proposals_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'proposals');

-- 4. HELPER VIEW (admin convenience)
CREATE OR REPLACE VIEW project_stats AS
SELECT
  COUNT(*)                                              AS total,
  COUNT(*) FILTER (WHERE status = 'pending')            AS pending,
  COUNT(*) FILTER (WHERE status = 'approved')           AS approved,
  COUNT(*) FILTER (WHERE status = 'rejected')           AS rejected,
  ROUND(AVG((ai_analysis->>'score')::NUMERIC), 1)       AS avg_ai_score
FROM projects;
