# S3 training environment and frozen method

## Pinned environment

- Python: **3.14** on macOS arm64.
- PyTorch: **2.13.0** (`torch==2.13.0`); use the macOS wheel and assert `torch.backends.mps.is_available()` before an MPS run.
- GLiNER: **0.2.27** (`gliner==0.2.27`).
- Transformers: **5.6.2** (`transformers==5.6.2`).
- Accelerate: **>=1.1.0**; GLiNER's `Trainer` and Transformers' torch training integration require it before training can start.
- Direct project dependencies are only stdlib, Torch, GLiNER, Transformers, and Accelerate. GLiNER/Transformers' normal transitive packaging dependencies are resolved by pip; no adapter, PEFT, data, metrics, or experiment-tracking package is used.
- Base checkpoint: **`urchade/gliner_multi_pii-v1` at revision `1fcf13e8`**. The GLiNER snapshot's own config freezes `max_len=384`, `max_width=12`, the mDeBERTa-v3-base backbone, and `fine_tune=true`.

Provision into a fresh virtual environment:

```bash
python3.14 -m venv .venv-pii-bank
source .venv-pii-bank/bin/activate
python -m pip install --upgrade pip
python -m pip install torch==2.13.0 gliner==0.2.27 transformers==5.6.2 'accelerate>=1.1.0'
python -c 'import torch; assert torch.backends.mps.is_available(), "MPS unavailable"; print(torch.__version__)'
```

Before every full run, store `python --version`, `pip freeze`, `sw_vers`, `sysctl -n hw.model`, `sysctl -n hw.memsize`, the three direct package versions, and the S3 source-file hashes in the local run JSON. `train.py` records the machine/package/source portion automatically; the operator adds the complete `pip freeze` digest when retaining evidence.

## Local-root rule

Set a local-only root; never place cache, artifacts, weights, or an absolute personal path in this repository:

```bash
export PII_BANK_LOCAL_ROOT=/operator/local/root
export PYTORCH_ENABLE_MPS_FALLBACK=1
```

The checkpoint cache is `${PII_BANK_LOCAL_ROOT}/context/pii-bank/train-runs/checkpoint-cache/`. Every run directory, saved artifact, selection log, and final frozen config is below `${PII_BANK_LOCAL_ROOT}/context/pii-bank/train-runs/`. Git records only local-root-relative references and SHA-256 values; weights and local paths are never committed. MPS fallback is opt-in above: `smoke.py` captures emitted fallback/MPS warnings in its result JSON, so a fallback cannot be invisible.

## Frozen method

S3 uses **full fine-tuning in FP32**: all checkpoint parameters remain trainable, with no frozen component or adapter. This is the compliant choice because the roughly 200M checkpoint fits MPS unified memory, FP32 is the mandatory MPS-protocol starting precision, and adapters would require PEFT or custom adapter scope beyond the allowed dependencies. The frozen geometry is sequence length **384** and maximum span width **12**. The ordered inference/training label map is `PERSON/person`, `LOCATION/location`, `VENDOR/vendor`, `ROLE/role`, `TECHNICAL_IDENTIFIER/technical identifier`. The tokenizer is the one bundled in the pinned GLiNER checkpoint snapshot (`tokenizer_source=base-checkpoint-bundled`, revision `1fcf13e8`); no mutable upstream tokenizer revision is accepted.

The saved-and-reloaded artifact is the only object passed to `eval_model.py`: after Trainer checkpoints, the runner explicitly writes the final local artifact with `GLiNER.save_pretrained()`, computes a directory-tree SHA-256, then reloads it with `GLiNER.from_pretrained(local_artifact)` for per-epoch/final dev scoring. Native in-memory metrics are never acceptance evidence.

MPS training is seed-controlled but not bit-deterministic: MPS scatter operations lack deterministic kernels. The preregistered three-seed median/range protocol mitigates this, and every run records the emitted nondeterministic operation names in `nondeterministic_ops`. Generator and corpus determinism proofs are unaffected.

## MPS smoke gate

Run this before any full MPS training:

```bash
python pii-bank/train/smoke.py --sample-path pii-bank/rows/dev.jsonl
```

It runs the same 10 positive/control rows on CPU and MPS in FP32, asserts finite loss and at least one finite gradient on both, and fails when `abs(cpu_loss - mps_loss) > max(0.05, 0.02 * abs(cpu_loss))`. The 2% relative / 0.05 absolute allowance is deliberately narrow enough to detect a material backend divergence while permitting normal FP32 reduction-order differences. A nonzero exit is a hard gate for full training.

## Sampling and custody

The training sampler, not duplicated rows, owns replay weighting. With an admitted public base mix it targets approximately 50% base replay, 25% contextual hard negatives, and 25% structural/domain positives on both update and token exposure. `general_synthetic` rows remain fresh synthetic positives/clean controls within the S2 25/25/50 corpus composition; they are grouped inside the synthetic structural/domain side and are never counted as the sampler's base-replay term. A `final` run refuses to start without an admitted local public base mix whose admission record hashes the staged corpus. `--mode smoke` and `--mode dev-explore` may run without it, but their run JSON carries `no_base_mix: true` and cannot be treated as an accepted run.

### Admitted base replay and attribution

Base replay is the local-only faithful train JSONL export of **OpenPII Masking
Mini 10K** (`ai4privacy/openpii-masking-mini-10k`, revision `ad851605`), whose
authoritative source partition is `train-00000-of-00001.parquet`. The loader
hash-checks both that parquet and the export before reading; it never reads the
validation file and never trusts the export's in-row `split` field (it is
constant `"train"` even for validation). `pyarrow`/`pandas` are therefore not
runtime dependencies.

The frozen replay label decision is GIVENNAME/SURNAME → PERSON and CITY/STREET
→ LOCATION only. EMAIL and TELEPHONENUM are dropped: PHONE is not a frozen
training label, and EMAIL is only an S4 scorer allowlist exception, not a
frozen training prompt. The other 13 upstream labels are likewise dropped from
spans; their source text remains replay context. Only EN/DE rows with at least
one retained span enter replay. Base rows are training-only and never affect
FP-per-1k scoring.

Attribution: Base-replay data: “OpenPII Masking Mini 10K”
(`ai4privacy/openpii-masking-mini-10k`, revision `ad851605`), a subset of
“OpenPII 1M — Multilingual PII Masking Dataset” (DOI 10.57967/hf/8202), by
**Ai4Privacy / Ai Suisse SA** (https://huggingface.co/datasets/ai4privacy/openpii-masking-mini-10k),
© 2026 Ai Suisse SA, licensed under **CC BY 4.0**
(https://creativecommons.org/licenses/by/4.0/). Modifications by Lucairn:
format conversion to the pii-bank span schema, label-subset mapping, and
train-file-only selection.

## S4 final-eval format boundary

The manifest freezes custody and native-asset hashes, but its measured JSON and
prose assets do not promise one common span schema. `eval_model.py` verifies the
native manifest asset only after `--final-eval`, then scores native canonical
rows or a frozen local canonical companion supplied through `--normalized-eval`.
`EVAL-FORMAT.md` defines that fail-closed companion contract. This preserves
S4's frozen-expected-output requirement without guessing offsets or categories
from measured prose; companions remain local-only evidence and are never
readable by training or dev selection.
