#!/usr/bin/env python3
"""Offline fixture integrity and input rendering. No network, selector, or model."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(root, name):
    return json.loads((root / name).read_text(encoding='utf-8'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def passages(root):
    result = []
    for doc in load(root, 'corpus.json')['documents']:
        data = (root / doc['path']).read_bytes()
        lines = data.decode('utf-8').splitlines()
        for p in doc['passages']:
            result.append({**p, 'document_id': doc['document_id'], 'version': doc['version'],
                           'published_at': doc['published_at'],
                           'text': lines[p['line_start'] - 1]})
    return result

def render_passage(p):
    return f"[{p['document_id']}@{p['version']}|{p['published_at']}|{p['passage_id']}]\n{p['text']}\n\n"

def render_evidence(root, run_id, omit=()):
    run = next(r for r in load(root, 'tasks.json')['runs'] if r['run_id'] == run_id)
    return ''.join(render_passage(p) for p in passages(root)
                   if p['document_id'] in run['document_ids'] and p['passage_id'] not in omit)

def question_text(root, run_id):
    run = next(r for r in load(root, 'tasks.json')['runs'] if r['run_id'] == run_id)
    return f"As of {run['as_of']}\n" + '\n'.join(q['question_id'] + ': ' + q['text'] for q in run['questions']) + '\n'

def model_input(root, run_id, omission=False):
    """Allowlisted model input only. No evaluator files or condition labels."""
    omitted = load(root, 'evaluator/omission-control.json')['remove_passage_ids'] if omission else []
    if omission and run_id != 'run2':
        raise ValueError('Omission control exists only for run2')
    return {'system': load(root, 'tasks.json')['system_prompt'],
            'user': question_text(root, run_id) + '\nEvidence:\n' + render_evidence(root, run_id, omitted)}

def validate(root=ROOT, verify_manifest=True):
    def require(test, message):
        if not test:
            raise ValueError(message)
    corpus = load(root, 'corpus.json')
    checklist = load(root, 'evaluator/checklist.json')
    tasks = load(root, 'tasks.json')
    protocol = load(root, 'evaluator/protocol.json')
    all_passages = passages(root)
    pmap = {p['passage_id']: p for p in all_passages}
    docs = {d['document_id']: d for d in corpus['documents']}
    require(len(docs) == len(corpus['documents']) == 6, 'Expected six unique documents')
    require(len(pmap) == len(all_passages) == 36, 'Expected 36 unique passages')
    require(corpus['synthetic'] is True, 'Synthetic marker required')
    for doc in docs.values():
        data = (root / doc['path']).read_bytes()
        require(data.endswith(b'\n') and b'\r' not in data, 'Source must be LF-terminated UTF-8')
        require(digest(data) == doc['sha256'], 'Source hash mismatch: ' + doc['document_id'])
        offset = 0
        lines = data.decode('utf-8').splitlines()
        require(len(lines) == len(doc['passages']), 'Every line must be a declared passage')
        for i, p in enumerate(doc['passages'], 1):
            quote = lines[i - 1].encode('utf-8')
            require(p['line_start'] == p['line_end'] == i, 'Incorrect line span')
            require(p['byte_start'] == offset and p['byte_end'] == offset + len(quote), 'Incorrect byte span')
            require(data[p['byte_start']:p['byte_end']] == quote, 'Byte span text mismatch')
            offset += len(quote) + 1
    items = checklist['items']
    imap = {i['item_id']: i for i in items}
    require(len(imap) == len(items) == 36, 'Checklist must classify each passage exactly once')
    require({i['passage_id'] for i in items} == set(pmap), 'Checklist coverage mismatch')
    require(sum(i['critical'] for i in items) == 12, 'Expected 12 critical and 24 noncritical spans')
    qmap = {q['question_id']: q for run in tasks['runs'] for q in run['questions']}
    require(len(qmap) == 7 and set(checklist['answer_rubric']) == set(qmap), 'Question/rubric coverage mismatch')
    for i in items:
        p = pmap[i['passage_id']]
        doc = docs[p['document_id']]
        for key in ('document_id', 'version', 'line_start', 'line_end', 'byte_start', 'byte_end'):
            require(i[key] == p[key], 'Checklist span mismatch: ' + key)
        require(i['quote'] == p['text'] and i['source_sha256'] == doc['sha256'], 'Checklist quote/hash mismatch')
        expected_runs = [r['run_id'] for r in tasks['runs'] if i['document_id'] in r['document_ids']]
        require(i['available_in'] == expected_runs, 'Checklist run availability mismatch')
        require(set(i['question_ids']) <= set(qmap), 'Unknown question reference')
        require(bool(i['question_ids']) == i['critical'], 'Criticality/question mapping mismatch')
    for qid, rubric in checklist['answer_rubric'].items():
        require(set(rubric['critical_items']) == {i['item_id'] for i in items if qid in i['question_ids']}, 'Rubric item mapping mismatch')
    for run in tasks['runs']:
        require(set(run['document_ids']) <= set(docs), 'Unknown document')
        require(all(docs[d]['published_at'] <= run['as_of'] for d in run['document_ids']), 'Future document leaks into run')
    require(tasks['runs'][0]['document_ids'] == ['D01','D02','D03'], 'Run1 availability changed')
    require(tasks['runs'][1]['new_document_ids'] == ['D04','D05','D06'], 'Run2 arrival set changed')
    control = load(root, 'evaluator/omission-control.json')
    require(control['remove_passage_ids'] == ['D03.p02'], 'Unexpected omission control')
    full = render_evidence(root, 'run2')
    omitted = render_evidence(root, 'run2', control['remove_passage_ids'])
    require(full.replace(render_passage(pmap['D03.p02']), '', 1) == omitted, 'Omission must change exactly one passage')
    # Canary is intentionally evaluator-only. Verify it cannot survive in control input.
    require('lantern-revert-q7m4' not in json.dumps(model_input(root, 'run2', True)), 'Control leaks missing answer')
    require('lantern-revert-q7m4' not in json.dumps(tasks), 'Questions leak missing answer')
    stats = {}
    for run in tasks['runs']:
        rid = run['run_id']
        available = [i for i in items if i['critical'] and rid in i['available_in']]
        critical_bytes = len(''.join(render_passage(pmap[i['passage_id']]) for i in available).encode('utf-8'))
        full_bytes = len(render_evidence(root, rid).encode('utf-8'))
        cap = protocol['budgets']['selected_evidence_utf8_bytes'][rid]
        require(critical_bytes <= cap < full_bytes, 'Budget must fit critical spans and require some reduction')
        stats[rid] = {'full_evidence_bytes': full_bytes, 'critical_union_bytes': critical_bytes, 'selection_cap_bytes': cap,
                      'critical_items': len(available)}
    require(protocol['execution_status'] == 'DESIGN_ONLY_NOT_EXECUTED', 'Unexpected execution claim')
    require(protocol['token_measurement']['status'] == 'PENDING_TARGET_LOCK', 'Unexpected token result')
    require(protocol['downstream_configuration']['model_snapshot'] is None, 'Unapproved model assumption')
    if verify_manifest:
        manifest = load(root, 'manifest.json')
        actual = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name != 'manifest.json')
        require(actual == sorted(manifest['files']), 'Manifest file set differs')
        for name, expected in manifest['files'].items():
            data = (root / name).read_bytes()
            require(digest(data) == expected['sha256'] and len(data) == expected['bytes'], 'Manifest mismatch: ' + name)
        require(manifest['fixture_id'] == corpus['fixture_id'], 'Manifest identity mismatch')
        require(manifest['integrity_scope'] == 'All files except manifest.json; SHA-256 over exact bytes', 'Unexpected manifest scope')
    return {'status': 'offline_integrity_pass', 'documents': 6, 'passages': 36, 'critical_items': 12,
            'noncritical_items': 24, 'budgets': stats, 'provider_calls': 0, 'model_calls': 0,
            'note': 'Feasibility and integrity only, not evidence-retention or answer-quality results.'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('validate')
    render = sub.add_parser('render')
    render.add_argument('--run', choices=['run1', 'run2'], required=True)
    render.add_argument('--omission-control', action='store_true')
    args = parser.parse_args()
    if args.command == 'validate':
        print(json.dumps(validate(), indent=2))
    else:
        validate()
        print(json.dumps(model_input(ROOT, args.run, args.omission_control), indent=2))

if __name__ == '__main__':
    main()
