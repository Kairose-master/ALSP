# Preregistered evaluation plan

## 1. Scope and freeze

The immutable fixture comprises six synthetic documents, two dated task sets, a 12-item critical checklist, an exhaustive noncritical classification, exact source/version spans, byte budgets, controls, and acceptance rules. `manifest.json` pins every payload file. Freeze it before inspecting any candidate selection. Any change to these definitions requires a new fixture version and manifest; never reclassify a missed item as noncritical after seeing results.

This is a design release. An actual run additionally requires a separately hashed execution lock outside this directory. Before the first candidate selection, record:

1. Fixture manifest SHA-256 and repository commit.
2. Selector provider, endpoint/version, exact task-to-request adapter, response mapping, supported parameters, seed/retry policy, and any provider token cap.
3. Exact downstream provider/model snapshot, decoding parameters, output allowance, supported seed policy, and context window.
4. Intended downstream tokenizer, implementation/version, vocabulary hash, encoding options, and any token budget. If a valid tokenizer cannot be supplied, leave token measurements unreported and preserve the byte-only experiment.
5. The deterministic randomization schedule, opaque judging IDs, and scorers/adjudication procedure.

No candidate selection is permitted while that lock is incomplete. Changing a target or a cap after inspecting output is a new experiment. Selecting a model for a future experiment is not authorization to invoke a paid service. None is invoked by these files.

## 2. Conditions and caller-managed state

At run 1, only D01-D03 exist for the task. At run 2, D04-D06 arrive. Documents are ordered by their declared list, then ascending passage ID. Every selected quote must retain its original document/version/passage attribution and publication timestamp.

- **F, full context:** provide all sources available for that run directly to the downstream model.
- **S, snapshot selection:** ask the candidate to select from all sources available for that run, then give its selected evidence to the same downstream model. Save the exact run-1 selection and its hash.
- **C, caller carryforward:** share the S run-1 selection. At run 2, supply only that saved selection plus all three new documents to the candidate. Its run-2 selection goes to a fresh downstream call. Do not recover an omitted old passage from the original corpus, pass a previous model answer, or silently supply hidden chat history.
- **O, omission control:** a separate run-2 downstream call receives full context minus D03.p02. All remaining evidence, questions, and system text are identical to F. Do not expose the O label, deletion list, or intended answer.

F versus S isolates snapshot-selection effects. S versus C at run 2 measures the effect of caller-managed carryforward, at an identical run-2 output cap. Diagnose propagated omissions by inspecting the saved spans. Changing the selector input composition can also change its selections even when S1 kept all critical evidence, so this comparison does not isolate omission alone. The service is not asked to retain state between requests. A C failure is not evidence that a provider's persistent memory failed.

Only the `selector_prompt` scalar may be extracted from `evaluator/protocol.json` for the selector instruction; never supply the evaluator file or its other fields. Give the selector only that instruction, the current task, eligible evidence, and locked request limits. It selects verbatim evidence; it does not answer questions or adjudicate conflicting sources. The evaluator's checklist and all expected answers are withheld from both selector and downstream model. The only permitted cross-run/condition output is the exact saved S run-1 evidence prescribed for C run 2; prior downstream answers remain forbidden.

## 3. Reference encoding and size accounting

A whole passage is encoded exactly as follows, using its real identifiers and exact source text:

```text
[document_id@version|published_at|passage_id]\n
exact source text\n
\n
```

`render_passage` in `tools/fixture.py` is authoritative. IDs and versions resolve to immutable source hashes in `corpus.json`. Each checklist item has a 1-based inclusive line range and a 0-based half-open UTF-8 byte range, excluding the line's final LF. The source documents currently use ASCII, so byte offsets remain unambiguous.

The evidence caps are 2,100 bytes in run 1 and 4,200 bytes in run 2. Include all reference wrappers and separators. Fixed questions and system instructions are outside this evidence cap but must be accounted for separately when reporting total prompt size. F and O are reference/control conditions exempt from selection caps; all downstream calls need enough context for F plus the fixed prompt and output allowance.

A future API adapter must be locked before use. Map genuine extractive output to exact original spans without adding lost text. If an output selects partial passages, preserve its exact source byte offsets in the locked adapter's wrapper and count that overhead. Partial retention cannot earn whole-item credit in this conservative fixture. Do not expand partial output from the corpus to make it pass. Report raw returned bytes, canonical downstream evidence bytes, and mapping errors separately. Duplicates earn no extra retention credit but still consume the budget.

An over-budget or unmappable output is an invalid candidate. Never silently truncate it or substitute oracle-selected passages. Record invalidity and the evidence/answer outcomes separately if an invalid output is examined diagnostically. Retrying because a score is poor is prohibited.

No token count or savings value has been computed. Once the intended tokenizer is locked, count evidence tokens and whole downstream prompt tokens separately. Use each run's full F evidence as the evidence-savings denominator. Also report selector input/output costs and the complete two-run cost so replay overhead is visible. Compiler/provider estimates stay labelled as estimates unless independently reproduced with the declared tokenizer. Byte reduction is never relabelled as token reduction.

## 4. Evidence scoring

Score each predefined critical item as 1 only when its entire exact quote survives with correct source/version attribution. This strict passage-level criterion deliberately includes qualifiers, dates, negation, units, scope, and both sides of the disagreement. Partial survival is 0. This is an operational fixture rule, not a claim that every word is semantically indispensable in every setting.

- Run 1 has five critical and 13 noncritical items.
- Run 2 has 12 critical and 24 noncritical items.
- Every normal condition is judged against the same run-specific gold set. C receives no easier gold set because it already lost something at run 1.
- Any missing critical item fails the evidence gate. Report its ID and missing span.
- Report noncritical retention separately. Removing noncritical content is permitted, and retaining it cannot offset critical loss.
- Incorrect attribution or fabricated text fails the corresponding critical item and the provenance gate.

O intentionally fails C05 retention and is excluded from compression-success comparisons. Its role is to test whether the downstream model notices insufficient evidence rather than guesses an exact identifier.

## 5. Downstream answer scoring

All conditions use the same locked downstream model snapshot, system instruction, decoding settings, and output allowance. Use fresh isolated calls. The only differences are the current run's questions and the prescribed evidence. Run 1 of C reuses S rather than issuing a redundant duplicate call.

Two scorers independently assess each answer on three separate dimensions:

1. **Completeness:** all required claims in the frozen per-question rubric are present. For F/S/C, judge against what the original corpus can answer. For O, only R2.Q4 changes to requiring insufficient evidence.
2. **Grounding:** each factual claim has a valid reference to actually supplied evidence that supports it. A correct answer guessed without evidence fails grounding.
3. **Calibration:** preserve negation, units, dates, sample limits and preliminary status; distinguish an explicit configuration supersession from unresolved QA disagreement; do not treat a later timestamp as authority or absence of a recorded approval as proof that approval never occurred.

Each dimension is binary and reported per question. A question passes only if all three pass. The answer gate passes only if every question passes. If selection omitted necessary evidence, a well-grounded abstention may pass grounding and calibration while failing completeness. Do not reward invented certainty merely because it matches the hidden answer key.

Report evidence and answer gates separately. A normal fixture-condition-run passes overall only when both pass and the output also meets the budget, provenance, and locked-configuration requirements. Size savings never compensate for failure. Report O's abstention performance separately from the normal fixture pass rate.

## 6. Randomization, blinding, repetitions

Use five preregistered blocks; report every block including invalid or failed calls. Derive ordering deterministically with SHA-256 of the strings specified in `evaluator/protocol.json`, choosing the smallest hash among jobs whose dependencies are ready. S1 must finish before C2. The eligible selector jobs are S.run1, S.run2, and C.run2. Eligible downstream jobs are F.run1, S.run1, F.run2, S.run2, C.run2, and O.run2. Selector jobs finish before downstream-call ordering is applied. No downstream answer is reused as selector input.

Lock supported seeds or explicitly state when seeds are unsupported. Use the same downstream configuration across conditions; never tune it after seeing a particular condition fail. If sampling cannot be deterministically reproduced, retain raw responses and report variability across all five blocks without cherry-picking. This small fixture is descriptive and does not justify a population-level significance claim.

A coordinator replaces condition/provider names with opaque IDs. Scorers see the question, candidate answer, supplied evidence, and frozen evaluator rubric, but not provider/condition labels, token/byte savings, or competing answers. They record independent decisions and adjudicate disagreements before labels are unblinded. Evidence-retention checks are separate. Different context lengths can partly reveal conditions, so blinding is limited rather than guaranteed.

## 7. Required result report for a future run

Publish the fixture version/manifest hash and execution lock; sanitized exact selector inputs/outputs, selected source spans, downstream prompts/answers, and run hashes; all critical/noncritical item scores; every question's three answer dimensions; size and cost accounting; over-budget/mapping/provenance failures; and paired F/S/C/O results for all blocks. The omission control must retain its hand-constructed provenance.

Keep empirical results distinct from integrity checks and budget-feasibility arithmetic. This release contains only the latter. Do not infer a service result, universal retention guarantee, conflict-resolution capability, provider memory, or model accuracy from it.
