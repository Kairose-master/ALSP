# Two-run research evidence fixture

**Status: frozen synthetic evaluation design, not a service benchmark result.** No Maha request, paid call, selector, or downstream model has been run for this fixture. Offline checks verify the fixture's integrity and budget feasibility only. There are no compression, token-savings, retention, or answer-quality measurements here.

This standalone example is intended to make a discussion about task-directed extractive passage selection testable. The proposed service role is to return selected passages with source references. Conflict resolution, authority judgments, and the final answer belong to the downstream research agent. Documents and any carryforward are supplied by the caller; this design assumes no persistent service memory.

## What is in the fixture?

Six short, entirely fictional documents describe a theatre-programme archive indexing pilot. They contain 36 source passages: 12 critical and 24 noncritical across the complete two-run task.

- **Run 1:** three documents establish an earlier configuration, a small QA observation, an unresolved fix/release question, and an exact support-package identifier.
- **Run 2:** three dated documents add an explicitly effective configuration amendment and two directly contradictory observations of the same retest, sample, and snapshot. The answer must keep earlier facts, the valid update, and unresolved uncertainty distinct.
- **Omission control:** remove the one decisive passage for the package-identifier question from otherwise full run-2 context. The original corpus answers it; the modified context cannot. The appropriate downstream answer is insufficient evidence. This control is hand-constructed, never represented as provider output.

All people, project facts, dates, identifiers, and documents in this fixture are synthetic. The exercise makes no claim about the real quality of any product.

## Files and boundaries

- `sources/D01.txt` through `D06.txt`: canonical source text, one passage per LF-terminated line.
- `corpus.json`: document IDs, versions, publication dates, exact hashes, and line/UTF-8 byte spans.
- `tasks.json`: the downstream instruction and frozen questions; no answer key.
- `evaluator/checklist.json`: exact critical/noncritical source spans and the answer rubric. **Evaluator only.**
- `evaluator/protocol.json`: machine-readable conditions, budgets, scoring, and launch gates.
- `evaluator/omission-control.json`: the evaluator's deliberate deletion recipe.
- `PROTOCOL.md`: the readable evaluation plan.
- `manifest.json`: exact-byte SHA-256 inventory, excluding the manifest itself.
- `tools/fixture.py` and `tools/test_fixture.py`: dependency-free offline validation and safe full/control input rendering. They do not implement a selector, API client, downstream runner, or scoring model.

Only the allowlisted task text and condition-specific evidence go to a selector or downstream model. Do not hand the entire directory to an agent. In particular, never pass evaluator files, this README, the protocol, control labels, validator code, or the manifest as model context. The renderer emits only `system` and `user` text. Public release means the corpus is not a secret held-out benchmark; a future generalization claim would require independent, uncontaminated fixtures.

## Offline checks

Python 3.10+ and the standard library are sufficient. From this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/fixture.py validate
PYTHONDONTWRITEBYTECODE=1 python3 tools/test_fixture.py
```

Generate isolated full-context/control model-input text, without calling any model:

```sh
python3 tools/fixture.py render --run run1 > /tmp/lantern-run1.json
python3 tools/fixture.py render --run run2 > /tmp/lantern-run2.json
python3 tools/fixture.py render --run run2 --omission-control > /tmp/lantern-control.json
```

Keep generated outputs and future execution locks outside this frozen directory. The manifest rejects unexpected files except Python bytecode caches. No repository dependency installation, network access, production build, payment, or deployment is needed.

## Frozen size budgets, pending token/model target

The selected-evidence caps are **2,100 UTF-8 bytes for run 1** and **4,200 UTF-8 bytes for run 2**, including source-reference wrappers. Full evidence is 3,763 and 7,473 bytes respectively. The complete critical-span unions occupy 858 and 2,078 bytes, so preserving every critical passage is feasible under each cap. These are arithmetic feasibility checks, not selections or empirical results.

Bytes are a size proxy, not model tokens. No downstream model or intended tokenizer has been chosen by the user. Their identities, exact versions, settings, and any token cap must be recorded in a separate hashed execution lock **before candidate selection begins**. Token metrics remain pending. A service/compiler-reported savings estimate must remain labelled as an estimate unless reproduced with the declared intended tokenizer. See the full accounting rules in [PROTOCOL.md](PROTOCOL.md).

## The acceptance rule

For a normal evaluated condition, losing **any** critical item fails this fixture/run, regardless of average retention or size reduction. Evidence preservation and downstream answer quality are scored separately. A lucky answer cannot repair missing evidence; a calibrated abstention after avoidable evidence loss does not satisfy completeness. The omission control is expected to fail retention and is evaluated separately for appropriate abstention.

This is a bounded, conservative acceptance test for these questions and sources. It is not a promise of perfect preservation across arbitrary research.

## Relationship to the existing repository

This is a new example directory, based on repository commit `4b35509f668c4b795ae411632b05493dea1bee89`. It does not alter the existing Maha JSON POST fixture, schemas, strict response decoder, transport, settlement logic, application, or deployment configuration. The existing example addresses request/response and evidence boundaries; this one defines a future semantic evaluation. Repository-wide integration tests are not claimed by the standalone checks above.
