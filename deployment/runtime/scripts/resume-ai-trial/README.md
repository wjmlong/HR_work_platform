# Local DeepSeek Flash resume trial

Standalone experiment for the user-provided automation full-stack JD. No PostgreSQL connection, upload-worker change, service restart or 190 deployment. Real resumes and credentials stay in private directories outside Git. The experiment uses the explicitly supplied company NewAPI model config (`baseUrl`, `apiKey`, `model`, `caFile`); never commit it. HTTPS certificate and hostname verification remain enabled.

## Current protocol

1. Read selectable PDF text with PDFium; use Flash OCR only for image pages. DOCX reads the package's `word/document.xml` without following external relationships. TXT is retained verbatim.
2. Generate immutable page/segment IDs locally. Flash semantic analysis returns facts and nine JD evidence assessments referencing those IDs, rather than rewriting source text or inventing quote strings.
3. Resolve references locally and reject unknown IDs, missing positive evidence, missing JD dimensions, unexpected score fields, unsupported experience-years values and model chronology assertions. A field labelled `工作年限：2` explicitly supplies the unit; an age or date does not. Unknown facts are omitted.
4. Model evidence states are demonstrated, mentioned, uncertain, not_found. They are evidence categories, not automatic scores or hiring decisions. One named automation tool with practical evidence can satisfy the OR requirement. A self-built engine with explicit implementation evidence can too. Related Agent/StateGraph work with unclear engine scope needs human verification.

OCR transcription is itself model output. An exact citation match guarantees provenance to transcription, not visual accuracy or semantic correctness. Human review remains necessary. Date comparisons need a separate deterministic implementation; this trial does not verify timeline authenticity.

## Running

Node 22 and existing backend dependencies. PDFium path is opt-in through `RECRUIT_TRIAL_PYTHON`; create an isolated Python environment with `pypdfium2==4.30.0` and `Pillow==11.3.0`. Do not silently fall back to PDF.js for the real-batch acceptance: the older path lost Chinese in a font-mapped sample. PDF.js remains for historical tests.

```sh
node --test scripts/resume-ai-trial/contract.test.mjs scripts/resume-ai-trial/semantic.test.mjs scripts/resume-ai-trial/document.test.mjs
RECRUIT_TRIAL_PYTHON=/absolute/venv/bin/python3 node scripts/resume-ai-trial/run-semantic.mjs /private/model.json /private/synthetic-output
node scripts/resume-ai-trial/jd-acceptance.mjs /private/model.json /private/jd-output
RECRUIT_TRIAL_PYTHON=/absolute/venv/bin/python3 node scripts/resume-ai-trial/batch.mjs /private/resumes /private/model.json /private/output
node scripts/resume-ai-trial/verify-batch.mjs /private/output
python3 scripts/resume-ai-trial/final-report.py /private/output
```

`retry-failed.mjs INPUT_DIR PRIVATE_CONFIG OUTPUT_DIR` preserves prior summaries and responses and reruns failed files serially. It does not mask original failures. `analyze.mjs`, `run.mjs`, `report.py` preserve the earlier protocol/experiment for comparison; `semantic.mjs` and `final-report.py` are current.

## Limits and evidence boundaries

- 10 MiB file, 10 PDF pages, 1600 px longest raster edge, 60k native text characters, 12 MiB prepared payload.
- Sequential page rendering inside an isolated preparation child, 45-second parent deadline (Python subprocess 30 seconds), 256 MiB V8 heap. Native PDF/image allocations are NOT bounded by the V8 heap; production requires OS/container CPU and memory limits. Preparation RSS includes conservative sum of Node and Python peaks, not whole-service peak usage.
- Model 90-second deadline, bounded response size, one retry for transient network/429/502/503/504. Up to three semantic format-validation attempts; final failure is surfaced, never fabricated into success.
- Real batch uses at most two concurrent files locally. Multiple production workers need a database-coordinated global limit rather than a per-process semaphore.
- On 2026-10-27, 34 real files were exercised. Bugs found: missing Chinese with the old PDF reader, an external DOCX template incorrectly blocking body reading, rewritten quotes, date ranges placed into years, unsupported missing-field facts and false future-date comments. All original attempts are retained in private reports.
- Synthetic checks cover Chinese name/education, positive vs negated/uncertain skills, stated years vs overlapping dates, compensation, malicious document instructions, image OCR and two-column scanned pages. JD-specific live checks cover OR tools, generic Agent ambiguity and explicit self-built engine.
- No reliable per-character OCR accuracy percentage or complete human-labelled semantic accuracy is claimed. Local test success does not mean upload UI integration or production deployment.

Before rollout: connect upload/versioning/review UI, preserve semantic status during correction/rescoring, implement durable global concurrency/idempotence, container resource limits, Linux staging tests and representative manually labelled acceptance. Existing scores and both deployments remain unchanged.
