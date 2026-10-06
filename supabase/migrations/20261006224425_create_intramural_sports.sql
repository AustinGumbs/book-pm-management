/*
# Intramural Sports Sign-Up

## Summary
Adds tables for intramural sports leagues and player sign-ups, enabling users
to browse available sports and register (sign up) to participate.

## New Tables

### `intramural_sports`
- `id` (uuid, primary key)
- `name` (text, not null) — e.g. "Indoor Soccer"
- `description` (text) — short blurb about the league
- `day_of_week` (text) — e.g. "Tuesdays"
- `start_date` (date) — when the league starts
- `end_date` (date) — when the league ends
- `max_players` (int, default 20) — roster cap
- `location` (text) — e.g. "Main Gym"
- `created_at` (timestamptz)

### `intramural_signups`
- `id` (uuid, primary key)
- `sport_id` (uuid, foreign key → intramural_sports, ON DELETE CASCADE)
- `player_name` (text, not null) — name of the person signing up
- `player_email` (text, not null) — contact email
- `created_at` (timestamptz)
- Unique constraint on (sport_id, player_email) to prevent duplicate sign-ups

## Security
- RLS enabled on both tables.
- Both tables are single-tenant (no auth): anon + authenticated can read and write.
  This is a community sign-up board — data is intentionally public/shared.
- No user_id columns, no auth.uid() checks.

## Indexes
- Index on `intramural_signups.sport_id` for fast roster lookups.
*/

CREATE TABLE IF NOT EXISTS intramural_sports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  day_of_week text DEFAULT '',
  start_date date,
  end_date date,
  max_players int NOT NULL DEFAULT 20,
  location text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE intramural_sports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sports" ON intramural_sports;
CREATE POLICY "anon_select_sports"
ON intramural_sports FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sports" ON intramural_sports;
CREATE POLICY "anon_insert_sports"
ON intramural_sports FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_sports" ON intramural_sports;
CREATE POLICY "anon_update_sports"
ON intramural_sports FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sports" ON intramural_sports;
CREATE POLICY "anon_delete_sports"
ON intramural_sports FOR DELETE
TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS intramural_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id uuid NOT NULL REFERENCES intramural_sports(id) ON DELETE CASCADE,
  player_name text NOT NULL,
  player_email text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (sport_id, player_email)
);

ALTER TABLE intramural_signups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_signups" ON intramural_signups;
CREATE POLICY "anon_select_signups"
ON intramural_signups FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_signups" ON intramural_signups;
CREATE POLICY "anon_insert_signups"
ON intramural_signups FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_signups" ON intramural_signups;
CREATE POLICY "anon_update_signups"
ON intramural_signups FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_signups" ON intramural_signups;
CREATE POLICY "anon_delete_signups"
ON intramural_signups FOR DELETE
TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_intramural_signups_sport_id
ON intramural_signups(sport_id);
