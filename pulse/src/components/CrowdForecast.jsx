import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import FitnessCenterIcon from '@mui/icons-material/FitnessCenter';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SchoolIcon from '@mui/icons-material/School';
import { tokens } from '../theme';

/**
 * CrowdForecast — a crowd-forecasting interface for the York U Fitness app.
 *
 * Shows real-time Tait McKenzie Fitness Centre occupancy and predicts the next
 * 8 hours of crowd levels as Low / Medium / High tiers, so first-year and
 * commuter students can find a quietly predictable time to train.
 *
 * Design contract (mirrors WeeklySummary):
 *   - The FORECAST ENGINE (this file, pure functions) computes every number.
 *     No AI invents occupancy — when live data is missing we surface an
 *     explicit "data unavailable" state rather than hallucinating.
 *   - The guardrails are enforced in pure functions: the engine never
 *     recommends a time outside operating hours, and mutes suggestions
 *     during a student's active class block.
 *   - Six named test states cover the Happy Path, edge cases, errors,
 *     empty states, and guardrail conflicts, adapted from the PRD.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FACILITY = 'Tait McKenzie Fitness Centre';
const CAPACITY = 220; // assumed working capacity for the Fitness Centre
const OPERATING_HOURS = {
  weekday: { open: 6, close: 23 },   // 6:00 AM – 11:00 PM
  weekend: { open: 8, close: 22 },   // 8:00 AM – 10:00 PM
};

const TIERS = {
  low:    { key: 'low',    label: 'Low',    color: '#4ADE80', threshold: 0.40 },
  medium: { key: 'medium', label: 'Medium', color: '#FBBF24', threshold: 0.75 },
  high:   { key: 'high',   label: 'High',   color: '#EF4444', threshold: 1.00 },
};

// A representative class timetable for a first-year commuter student.
// Each block is [dayIndex, startHour, endHour] where dayIndex 0=Sun..6=Sat.
const CLASS_TIMETABLE = [
  { day: 1, start: 10, end: 11.5, name: 'KINE 1010 Lecture' },   // Mon
  { day: 1, start: 14, end: 15.5, name: 'BIOL 1000 Lab' },       // Mon
  { day: 1, start: 16, end: 18, name: 'Afternoon Class' },       // Mon 4–6 PM
  { day: 2, start: 9,  end: 10.5, name: 'PSYC 1010 Lecture' },   // Tue
  { day: 2, start: 16, end: 18, name: 'Afternoon Class' },       // Tue 4–6 PM
  { day: 3, start: 13, end: 14.5, name: 'MATH 1500 Tutorial' },  // Wed
  { day: 3, start: 16, end: 18, name: 'Afternoon Class' },       // Wed 4–6 PM
  { day: 4, start: 10, end: 11.5, name: 'KINE 1010 Lecture' },   // Thu
  { day: 4, start: 16, end: 18, name: 'Afternoon Class' },       // Thu 4–6 PM
  { day: 5, start: 11, end: 12.5, name: 'CHEM 1000 Lab' },       // Fri
  { day: 5, start: 16, end: 18, name: 'Afternoon Class' },       // Fri 4–6 PM
];

// ---------------------------------------------------------------------------
// Test states — the six named situations this feature must handle.
// `now` is an ISO string so each state pins a clock for deterministic render.
// `live` is the live occupancy count (null = stream offline).
// `surge` bumps the current hour's occupancy upward (edge case).
// ---------------------------------------------------------------------------
const TEST_STATES = [
  {
    key: 'happyPath',
    label: 'Happy Path',
    now: new Date(new Date().setHours(14, 5, 0, 0)).toISOString(),
    live: 96,
    dataOnline: true,
    isWeekend: false,
  },
  {
    key: 'offHours',
    label: 'Off-Hours / Closed',
    now: new Date(new Date().setHours(23, 30, 0, 0)).toISOString(),
    live: 0,
    dataOnline: true,
    isWeekend: false,
  },
  {
    key: 'surgeSpike',
    label: 'Surge Spike',
    now: new Date(new Date().setHours(16, 0, 0, 0)).toISOString(),
    live: 188,
    dataOnline: true,
    isWeekend: false,
  },
  {
    key: 'weekend',
    label: 'Weekend Curve',
    now: new Date(new Date().setHours(9, 30, 0, 0)).toISOString(),
    live: 24,
    dataOnline: true,
    isWeekend: true,
  },
  {
    key: 'offline',
    label: 'Offline / Missing Data',
    now: new Date(new Date().setHours(13, 0, 0, 0)).toISOString(),
    live: null,
    dataOnline: false,
    isWeekend: false,
  },
  {
    key: 'guardrailConflict',
    label: 'Guardrail Conflict',
    now: new Date(new Date().setHours(10, 30, 0, 0)).toISOString(),
    live: 40,
    dataOnline: true,
    isWeekend: false,
  },
];

// ---------------------------------------------------------------------------
// Forecast engine — pure functions, no I/O, no hallucinated data.
// ---------------------------------------------------------------------------

// A weekday occupancy baseline (fraction of capacity) per hour, derived from
// a typical Tait McKenzie class-gap curve. Peaks at the 4–7 PM rush.
const WEEKDAY_BASELINE = {
  6: 0.05, 7: 0.12, 8: 0.18, 9: 0.22, 10: 0.28, 11: 0.30,
  12: 0.42, 13: 0.38, 14: 0.35, 15: 0.45, 16: 0.68, 17: 0.82,
  18: 0.88, 19: 0.78, 20: 0.55, 21: 0.32, 22: 0.12,
};
// Weekend curve: quieter mornings, midday bump, early evening taper.
const WEEKEND_BASELINE = {
  8: 0.10, 9: 0.18, 10: 0.30, 11: 0.40, 12: 0.52, 13: 0.48,
  14: 0.42, 15: 0.38, 16: 0.45, 17: 0.50, 18: 0.46, 19: 0.34, 20: 0.18, 21: 0.08,
};

function getBaseline(hour, isWeekend) {
  const table = isWeekend ? WEEKEND_BASELINE : WEEKDAY_BASELINE;
  return table[hour] ?? 0;
}

function tierFor(fraction) {
  if (fraction < TIERS.low.threshold) return TIERS.low;
  if (fraction < TIERS.medium.threshold) return TIERS.medium;
  return TIERS.high;
}

function operatingInfo(date, isWeekend) {
  const cfg = isWeekend ? OPERATING_HOURS.weekend : OPERATING_HOURS.weekday;
  return { open: cfg.open, close: cfg.close };
}

function isOpenAt(date, isWeekend) {
  const { open, close } = operatingInfo(date, isWeekend);
  const h = date.getHours() + date.getMinutes() / 60;
  return h >= open && h < close;
}

// Is the given hour block inside a known class for this student?
function classConflict(date) {
  const day = date.getDay();
  const h = date.getHours() + date.getMinutes() / 60;
  return CLASS_TIMETABLE.find((c) => c.day === day && h >= c.start && h < c.end) || null;
}

// Build the next 8 hourly forecast buckets starting from the current hour.
// Each bucket: { hour, label, fraction, count, tier, closed, inClass, isLive }
function buildForecast({ now, live, isWeekend }) {
  const date = new Date(now);
  const { open, close } = operatingInfo(date, isWeekend);
  const buckets = [];
  for (let i = 0; i < 8; i++) {
    const bucketDate = new Date(date);
    bucketDate.setHours(date.getHours() + i, 0, 0, 0);
    const hour = bucketDate.getHours();
    const closed = hour < open || hour >= close;
    const conflict = classConflict(bucketDate);

    let fraction = 0;
    let count = 0;
    if (!closed) {
      fraction = getBaseline(hour, isWeekend);
      // If this is the "current" bucket and we have live data, blend it in:
      // recent live value weighted heavily (the 4-week trend is the baseline;
      // the live read snaps the now-hour to reality).
      if (i === 0 && typeof live === 'number') {
        const liveFraction = live / CAPACITY;
        fraction = Math.max(0, Math.min(1, 0.3 * fraction + 0.7 * liveFraction));
      }
      count = Math.round(fraction * CAPACITY);
    }

    buckets.push({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      fraction,
      count,
      tier: closed ? null : tierFor(fraction),
      closed,
      inClass: !!conflict,
      className: conflict?.name || null,
      isLive: i === 0 && typeof live === 'number',
    });
  }
  return buckets;
}

// Recommend the next best quiet, open, non-class window from the forecast.
function recommendBucket(buckets) {
  return buckets.find((b) => !b.closed && !b.inClass && b.tier.key === 'low')
    || buckets.find((b) => !b.closed && !b.inClass && b.tier.key === 'medium')
    || null;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function pct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CrowdForecast() {
  const [stateKey, setStateKey] = useState(TEST_STATES[0].key);
  const [now, setNow] = useState(() => new Date().toISOString());

  const state = useMemo(
    () => TEST_STATES.find((s) => s.key === stateKey) ?? TEST_STATES[0],
    [stateKey]
  );

  // For the happy path we let the clock tick so "live occupancy" feels live;
  // other states are pinned to a deterministic moment for eval.
  useEffect(() => {
    if (state.key !== 'happyPath') return undefined;
    const id = setInterval(() => setNow(new Date().toISOString()), 30000);
    return () => clearInterval(id);
  }, [state.key]);

  const effectiveNow = state.key === 'happyPath' ? now : state.now;

  const forecast = useMemo(
    () => buildForecast({ now: effectiveNow, live: state.live, isWeekend: state.isWeekend }),
    [effectiveNow, state.live, state.isWeekend]
  );

  const current = forecast[0];
  const open = isOpenAt(new Date(effectiveNow), state.isWeekend);
  const conflict = classConflict(new Date(effectiveNow));
  const recommendation = useMemo(() => recommendBucket(forecast), [forecast]);

  const handleChange = useCallback((_, next) => {
    if (next !== null) setStateKey(next);
  }, []);

  const dataOnline = state.dataOnline;
  const showHistoricalOnlyBanner = !dataOnline;

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', px: 2, py: 3 }}>
      <Typography variant="h5" sx={{ fontSize: '1.2rem', mb: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <FitnessCenterIcon sx={{ color: 'primary.light', fontSize: 22 }} />
        Gym Crowd Forecast
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {FACILITY} — live occupancy and the next 8 hours.
      </Typography>

      {/* Offline / historical-only banner — never hallucinate. */}
      {showHistoricalOnlyBanner && (
        <Alert
          severity="warning"
          id="offline-banner"
          sx={{ mb: 2, '& .MuiAlert-icon': { color: '#FBBF24' } }}
        >
          <AlertTitle>Historical estimates only — live data offline</AlertTitle>
          The check-in data stream is unavailable. The forecast below uses
          historical hourly baselines and may not reflect conditions right now.
        </Alert>
      )}

      {/* Closed state — suppress forecasts entirely. */}
      {!open && (
        <Card id="closed-card" sx={{ mb: 2 }}>
          <CardContent sx={{ py: 4, textAlign: 'center' }}>
            <Typography variant="h6" sx={{ fontSize: '0.9rem', mb: 1 }}>
              Facility Closed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {FACILITY} is closed at {formatClock(effectiveNow)}. Forecasts are
              hidden until opening hours.
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Live traffic badge */}
      {open && (
        <Card id="live-occupancy-card" sx={{ mb: 2 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  Right now
                </Typography>
                {dataOnline ? (
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography
                      component="span"
                      sx={{
                        fontFamily: '"Space Grotesk", sans-serif',
                        fontSize: '2.5rem',
                        fontWeight: 700,
                        lineHeight: 1,
                        color: current.tier?.color || 'text.primary',
                      }}
                    >
                      {current.count}
                    </Typography>
                    <Typography component="span" variant="body2" color="text.secondary">
                      / {CAPACITY} · {pct(current.fraction)}
                    </Typography>
                  </Box>
                ) : (
                  <Typography
                    sx={{
                      fontFamily: '"Space Grotesk", sans-serif',
                      fontSize: '1.6rem',
                      fontWeight: 700,
                      color: 'text.secondary',
                    }}
                  >
                    Data unavailable
                  </Typography>
                )}
              </Box>

              {dataOnline && current.tier && (
                <Chip
                  id="traffic-badge"
                  label={current.tier.label}
                  sx={{
                    backgroundColor: `${current.tier.color}22`,
                    color: current.tier.color,
                    border: `1px solid ${current.tier.color}`,
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    fontFamily: '"Space Grotesk", sans-serif',
                    letterSpacing: '0.08em',
                    px: 1,
                  }}
                />
              )}
            </Box>

            {/* Guardrail: in-class reminder */}
            {conflict && (
              <Alert
                severity="info"
                icon={<SchoolIcon />}
                id="class-conflict-alert"
                sx={{ mt: 2, backgroundColor: 'rgba(227,24,55,0.08)', '& .MuiAlert-icon': { color: tokens.violetBright } }}
              >
                You have <strong>{conflict.name}</strong> until{' '}
                {formatHourDecimal(conflict.end)}. Workout suggestions are muted
                during your class.
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* 8-hour forecast chart */}
      {open && (
        <Card id="forecast-card" sx={{ mb: 2 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6" sx={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 1 }}>
                <AccessTimeIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                Next 8 hours
              </Typography>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                {Object.values(TIERS).map((t) => (
                  <Box key={t.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.color }} />
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
                      {t.label}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>

            <Box sx={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={forecast} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.chartGrid} vertical={false} />
                  <XAxis dataKey="label" stroke="#8E8EA0" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="#8E8EA0"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: tokens.surfaceRaised,
                      border: `1px solid ${tokens.borderViolet}`,
                      borderRadius: 8,
                      color: '#F5F5FA',
                      fontSize: 13,
                    }}
                    labelStyle={{ color: '#8E8EA0' }}
                    cursor={{ fill: tokens.accentDim08 }}
                    formatter={(value, _name, item) => {
                      const b = item?.payload;
                      if (!b) return [value, 'Occupancy'];
                      if (b.closed) return ['Closed', 'Status'];
                      if (b.inClass) return [`${b.className} (class)`, 'Conflict'];
                      const tier = b.tier?.label || '—';
                      return [`${value}% · ${tier} · ${b.count}/${CAPACITY}`, 'Occupancy'];
                    }}
                  />
                  <ReferenceLine y={40} stroke="#4ADE80" strokeDasharray="4 4" strokeOpacity={0.4} />
                  <ReferenceLine y={75} stroke="#FBBF24" strokeDasharray="4 4" strokeOpacity={0.4} />
                  <Bar dataKey={(d) => (d.closed ? 0 : Math.round(d.fraction * 100))} radius={[6, 6, 0, 0]}>
                    {forecast.map((b, idx) => (
                      <Cell
                        key={idx}
                        fill={b.closed ? 'rgba(142,142,160,0.25)' : (b.tier?.color || tokens.violetBright)}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Box>

            {/* Hourly tier list — accessible companion to the chart */}
            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {forecast.map((b, idx) => (
                <Box
                  key={idx}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    py: 0.75,
                    px: 1,
                    borderRadius: 1,
                    backgroundColor: idx === 0 ? tokens.accentDim08 : 'transparent',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Typography variant="body2" sx={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600, minWidth: 52 }}>
                      {b.label}
                    </Typography>
                    {b.closed ? (
                      <Typography variant="caption" color="text.secondary">Closed</Typography>
                    ) : b.inClass ? (
                      <Typography variant="caption" sx={{ color: tokens.violetBright }}>
                        {b.className} (class)
                      </Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {pct(b.fraction)} · {b.count}/{CAPACITY}
                        {b.isLive && dataOnline ? ' · live' : ''}
                      </Typography>
                    )}
                  </Box>
                  {b.tier && !b.closed && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ width: 8, height: 8, borderRadius: 2, backgroundColor: b.tier.color }} />
                      <Typography variant="caption" sx={{ color: b.tier.color, fontWeight: 700, fontFamily: '"Space Grotesk", sans-serif' }}>
                        {b.tier.label}
                      </Typography>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Recommendation — muted during class / closed hours (guardrail) */}
      {open && !conflict && recommendation && (
        <Card id="recommendation-card" sx={{ mb: 2, borderColor: recommendation.tier.color }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <AutoAwesomeQuietIcon color={recommendation.tier.color} />
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                Quietest window coming up
              </Typography>
              <Typography sx={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 600 }}>
                {recommendation.label} — {recommendation.tier.label} ({pct(recommendation.fraction)})
              </Typography>
            </Box>
          </CardContent>
        </Card>
      )}
      {open && conflict && (
        <Box id="recommendation-muted" sx={{ mb: 2, textAlign: 'center', color: 'text.secondary', fontSize: '0.8rem' }}>
          Suggestions are muted during your scheduled class.
        </Box>
      )}

      {/* Test-state switcher — click through the six situations */}
      <Box sx={{ mt: 3 }}>
        <Typography
          variant="subtitle1"
          sx={{ fontSize: '0.75rem', color: 'text.secondary', mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.12em' }}
        >
          Test states
        </Typography>
        <ToggleButtonGroup
          value={stateKey}
          exclusive
          onChange={handleChange}
          aria-label="Crowd forecast test state"
          sx={{ flexWrap: 'wrap', gap: 1, '& .MuiToggleButton-root': { borderRadius: '10px !important', border: '1px solid', borderColor: 'divider', px: 2 } }}
        >
          {TEST_STATES.map((s) => (
            <ToggleButton key={s.key} value={s.key} id={`crowd-test-state-${s.key}`} sx={{ fontSize: '0.72rem' }}>
              {s.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>
    </Box>
  );
}

function formatHourDecimal(h) {
  const hr = Math.floor(h);
  const m = Math.round((h - hr) * 60);
  return `${String(hr).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function AutoAwesomeQuietIcon({ color }) {
  // Small inline sparkle so we don't pull another icon import for one use.
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      sx={{ width: 22, height: 22, color, flexShrink: 0 }}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"
      />
    </Box>
  );
}
