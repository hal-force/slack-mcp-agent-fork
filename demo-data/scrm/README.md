# demo-data/scrm — Public-Sector SCRM synthetic dataset

Synthetic supply-chain-risk-management (SCRM) data for the Cohere Slack agent demo:
a federal program office monitoring supplier risk across 7 KRIs (NIST SP 800-161 /
FASCSA aligned), used to drive (a) an automated **risk brief** and (b) a multi-agent
**triage**. Mirrors `demo-data/vha`.

## Generate & validate

```bash
node demo-data/scrm/generate.js    # writes the CSVs (deterministic, seed 20260924)
node demo-data/scrm/validate.js    # recomputes the planted effects; exit 0 = OK
```

## Files

| File | Rows | Publish? | Purpose |
|---|---|---|---|
| `scrm_risk_snapshots.csv` | 5,040 | ✅ | date × supplier × KRI history — the Pulse/alert source |
| `scrm_suppliers.csv` | 40 | ✅ (filtered) | supplier dimension. **Publish a copy WITHOUT `composite_risk_pct`** |
| `scrm_risk_registry.csv` | 7 | ✅ | KRI definitions (threshold, direction, owning channel/function) |
| `scrm_components.csv` | 116 | ✅ | parts & provenance (single-source / Sec. 889 / SBOM) |
| `scrm_contracts.csv` | 93 | ✅ | program/contract exposure |
| `scrm_findings.csv` | 100 | ✅ | qualitative mitigations (sanitized) |
| `scrm_redteam_injection.csv` | 1 | ❌ NEVER | raw prompt-injection demo fixture |

## Guardrails

- **`composite_risk_pct` (on `scrm_suppliers.csv`) is a derived validation aid** —
  exclude it from the published supplier datasource and instruct the agent not to
  cite it (it is circular). Publish `publish/suppliers_filtered.csv` instead (created
  at publish time, mirroring the VHA `patients_filtered.csv` recipe).
- **`scrm_redteam_injection.csv` is never published.** The clean `scrm_findings.csv`
  has the injection sanitized out.
- Publish each table as its **own passthrough datasource** (no Prep-time joins) so
  each keeps its grain and its own LUID — the agent queries tables by LUID and must
  not fan out.

## The planted effects & the answer key

`generate.js` plants three recoverable statistical effects plus documented decoys.
The **scoring key is quarantined** in `tests/eval/scrm/` (`GROUND_TRUTH.md`,
`manifest.json`, `questions.json`) and must never be shown to an agent under
evaluation. `SCHEMA.md` here is a neutral dictionary with no magnitudes.

See `docs/SCRM-DEMO-DESIGN.md` for the full demo design (brief + triage + Cohere
specifics + milestones).
