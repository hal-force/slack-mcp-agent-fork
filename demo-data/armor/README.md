# demo-data/armor — DHA ARMOR synthetic dataset

Synthetic Integrated Workforce & Readiness data for the Cohere Slack agent
demo: a Defense Health Agency (DHA) capacity model across 10 Military
Treatment Facilities (MTFs) x 6 unit types, used to drive (a) an automated
**readiness brief** and (b) a multi-agent **net assessment / what-if**.
Mirrors `demo-data/scrm`.

## Generate & validate

```bash
node demo-data/armor/generate.js    # writes the CSVs (deterministic, seed 20260929)
node demo-data/armor/validate.js    # recomputes the planted effects; exit 0 = OK
```

## Files

| File | Rows | Publish? | Purpose |
|---|---|---|---|
| `armor_staffing_model.csv` | 6 | ✅ | capacity-model source of truth (beds_per_staff, required specialty/privilege, thresholds, routing) |
| `armor_facilities.csv` | 10 | ✅ | MTF dimension (market, region, command, sole regional role) |
| `armor_bed_capacity.csv` | 60 | ✅ | mtf x unit_type -> baseline physical beds / square footage / MEPRS code |
| `armor_billets.csv` | 436 | ✅ | authorized manpower positions (DHMRSi) |
| `armor_personnel.csv` | 384 | ✅ | assigned people (who's actually there) |
| `armor_credentials.csv` | 384 | ✅ | CCQAS privileging status |
| `armor_readiness.csv` | 384 | ✅ | medical clearance + JKSA currency |
| `armor_readiness_snapshots.csv` | 1,080 | ✅ | month x mtf x unit_type history — the Pulse/alert source |
| `armor_taskings.csv` | 10 | ✅ | proposed & executed staffing changes (the what-if input) |
| `armor_redteam_injection.csv` | 1 | ❌ NEVER | raw prompt-injection demo fixture |

## Guardrails

- **No `overall_readiness_pct` (or any composite roll-up) is ever emitted.**
  Readiness must be recovered from the underlying manpower / credentialing /
  clearance tables — there is no precomputed shortcut column to cite.
- **`armor_redteam_injection.csv` is never published.** The clean
  `armor_taskings.csv` has the injection sanitized out of the one note that
  carried it.
- Publish each table as its **own passthrough datasource** (no Prep-time
  joins) so each keeps its grain and its own LUID — the agent queries tables
  by LUID and must not fan out.

## The planted effects & the answer key

`generate.js` plants three recoverable effects (E1 manpower-vs-personnel
fill/erosion gap, E2 the burn-center-vs-deep-bench what-if interaction, E3 the
facility-size null) plus documented decoys. The **scoring key is
quarantined** in `tests/eval/armor/` (`GROUND_TRUTH.md`, `manifest.json`,
`questions.json`) and must never be shown to an agent under evaluation.
`SCHEMA.md` here is a neutral dictionary with no magnitudes.

See `docs/ARMOR-DEMO-DESIGN.md` for the full demo design (readiness brief +
multi-agent net assessment + adversarial reviewer + Cohere specifics +
milestones).
