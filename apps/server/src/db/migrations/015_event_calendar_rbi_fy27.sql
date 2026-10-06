-- 015_event_calendar_rbi_fy27.sql
--
-- RBI MPC decision days for FY 2026-27, from RBI's press release "Meeting Schedule of the
-- Monetary Policy Committee for 2026-2027" (23 Mar 2026):
--   https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=62422
-- The release lists three-day meetings; the decision is announced on the last day.
--
-- 008 seeded April 2026 as 04-07, but that meeting ran 6-8 April and the policy was announced
-- on the 8th. 008 is not edited, because the runner tracks migrations by file name and
-- databases that already applied it would never see the fix. The wrong row is replaced here.
--
-- Rate outcomes are not recorded; descriptions say "scheduled", as 008 does for future dates.
-- Without these rows, regime tagging treats these days as ordinary days instead of EVENT_DAY.

DELETE FROM event_calendar
 WHERE event_date = '2026-04-07' AND event_type = 'RBI_POLICY';

INSERT INTO event_calendar (event_date, event_type, description) VALUES
  ('2026-04-08', 'RBI_POLICY', 'RBI MPC April 2026 (meeting Apr 6-8)'),
  ('2026-08-05', 'RBI_POLICY', 'RBI MPC August 2026 (meeting Aug 3-5) — scheduled'),
  ('2026-10-07', 'RBI_POLICY', 'RBI MPC October 2026 (meeting Oct 5-7) — scheduled'),
  ('2026-12-04', 'RBI_POLICY', 'RBI MPC December 2026 (meeting Dec 2-4) — scheduled'),
  ('2027-02-05', 'RBI_POLICY', 'RBI MPC February 2027 (meeting Feb 3-5) — scheduled')
ON CONFLICT (event_date, event_type) DO NOTHING;
