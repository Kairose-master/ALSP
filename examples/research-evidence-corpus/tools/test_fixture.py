#!/usr/bin/env python3
"""Offline integrity regressions, not a selector/model evaluation."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from fixture import ROOT, load, model_input, render_evidence, validate

class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'fixture'
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns('__pycache__'))
    def tearDown(self):
        self.temp.cleanup()
    def edit_json(self, name, edit):
        data = load(self.root, name)
        edit(data)
        (self.root / name).write_text(json.dumps(data) + '\n')
    def test_frozen_fixture_validates(self):
        self.assertEqual(validate(self.root)['status'], 'offline_integrity_pass')
    def test_source_mutation_is_rejected(self):
        p = self.root / 'sources/D01.txt'
        p.write_text(p.read_text().replace('64 MiB', '65 MiB'))
        with self.assertRaisesRegex(ValueError, 'Source hash mismatch'):
            validate(self.root)
    def test_wrong_version_is_rejected(self):
        self.edit_json('evaluator/checklist.json', lambda x: x['items'][1].update(version='9.0'))
        with self.assertRaisesRegex(ValueError, 'Checklist span mismatch: version'):
            validate(self.root, False)
    def test_wrong_byte_span_is_rejected(self):
        self.edit_json('corpus.json', lambda x: x['documents'][0]['passages'][1].update(byte_start=0))
        with self.assertRaisesRegex(ValueError, 'Incorrect byte span'):
            validate(self.root, False)
    def test_unclassified_passage_is_rejected(self):
        self.edit_json('evaluator/checklist.json', lambda x: x['items'].pop())
        with self.assertRaisesRegex(ValueError, 'classify each passage'):
            validate(self.root, False)
    def test_critical_downgrade_is_rejected(self):
        self.edit_json('evaluator/checklist.json', lambda x: x['items'][1].update(critical=False))
        with self.assertRaisesRegex(ValueError, '12 critical'):
            validate(self.root, False)
    def test_underfunded_budget_is_rejected(self):
        self.edit_json('evaluator/protocol.json', lambda x: x['budgets']['selected_evidence_utf8_bytes'].update(run1=100))
        with self.assertRaisesRegex(ValueError, 'Budget must fit'):
            validate(self.root, False)
    def test_future_document_leak_is_rejected(self):
        self.edit_json('tasks.json', lambda x: x['runs'][0].update(as_of='2026-03-01T00:00:00Z'))
        with self.assertRaisesRegex(ValueError, 'Future document'):
            validate(self.root, False)
    def test_omission_input_has_no_identifier_or_control_label(self):
        text = json.dumps(model_input(self.root, 'run2', True))
        self.assertNotIn('lantern-revert-q7m4', text)
        self.assertNotIn('HAND-CONSTRUCTED', text)
        self.assertNotIn('R2.Q4\":', text)  # No answer-rubric object.
        self.assertIn('R2.Q4:', text)
    def test_control_preserves_other_evidence(self):
        full = render_evidence(self.root, 'run2')
        control = render_evidence(self.root, 'run2', ['D03.p02'])
        self.assertEqual(full.count('[D'), 36)
        self.assertEqual(control.count('[D'), 35)
        self.assertIn('0 of the same 20', control)
        self.assertIn('1 of the same 20', control)
    def test_unexpected_file_is_rejected(self):
        (self.root / 'extra.txt').write_text('unregistered content')
        with self.assertRaisesRegex(ValueError, 'Manifest file set'):
            validate(self.root)
    def test_protocol_tamper_is_rejected(self):
        p = self.root / 'PROTOCOL.md'
        p.write_text(p.read_text() + '\nChanged acceptance.\n')
        with self.assertRaisesRegex(ValueError, 'Manifest mismatch'):
            validate(self.root)

if __name__ == '__main__':
    unittest.main(verbosity=2)
