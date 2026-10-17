import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {matchTextOperations} from '../dist/text-matching.mjs';

function operation(index, str, bbox = null) {
 return {index, str, fontId: 'transaction-font', bbox};
}

function item(text, x = Number.NaN, y = Number.NaN) {
 return {text, fontId: 'transaction-font', x, y, tolerance: 30};
}

test('page matching derives local coordinates from the text transform, not inspector globals', async () => {
 const app = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');
 assert.match(app, /x:normalizeMeasure\(t\[4\]\),y:normalizeMeasure\(t\[5\]\)/);
 assert.match(app, /const bbox=page\.recordedBBoxes;const operationMatches=matchTextOperations/);
 assert.doesNotMatch(app, /Math\.abs\(bx-x\)\+Math\.abs\(by-y\)/);
});

test('repeated transaction cells match in reading order only as an exact one-to-one operation match', () => {
 const rowTexts = [
  ['2025-01-02', 'TX-1042', 'Monthly fee', '10.00', '990.00'],
  ['2025-01-02', 'TX-1043', 'Monthly fee', '10.00', '980.00'],
  ['2025-01-03', 'TX-1044', 'Adjustment', '5.00', '975.00'],
 ];
 const items = rowTexts.flat().map(value => item(value));
 const operations = rowTexts.flatMap((row, r) => row.map((value, c) => operation(r * 5 + c + 1, value)));
 const matches = matchTextOperations(items, operations);
 assert.deepEqual(matches.map(group => group.map(op => op.index)), operations.map(op => [op.index]));
});

test('bounding-box proximity distinguishes repeated dates, IDs, remarks, amounts and balances', () => {
 const cells = [
  {text: '2025-01-02', x: 40, y: 90, op: 1}, {text: '2025-01-02', x: 40, y: 70, op: 6},
  {text: 'TX-1042', x: 120, y: 90, op: 2}, {text: 'TX-1043', x: 120, y: 70, op: 7},
  {text: 'Monthly fee', x: 200, y: 90, op: 3}, {text: 'Monthly fee', x: 200, y: 70, op: 8},
  {text: '10.00', x: 300, y: 90, op: 4}, {text: '10.00', x: 300, y: 70, op: 9},
  {text: '990.00', x: 380, y: 90, op: 5}, {text: '980.00', x: 380, y: 70, op: 10},
 ];
 const matches = matchTextOperations(cells.map(c => item(c.text, c.x, c.y)), cells.map(c => operation(c.op, c.text, {x: c.x, y: c.y})));
 assert.deepEqual(matches.map(group => group.map(op => op.index)), cells.map(c => [c.op]));
});

test('extra candidate operations keep repeated text ambiguous instead of guessing', () => {
 const matches = matchTextOperations([item('10.00'), item('10.00')], [
  operation(1, '10.00'), operation(2, '10.00'), operation(3, '10.00'),
 ]);
 assert.deepEqual(matches, [[], []]);
});

test('overlapping multi-operation groups cannot be treated as one-to-one matches', () => {
 const matches = matchTextOperations([item('AB'), item('B')], [operation(1, 'A'), operation(2, 'B')]);
 assert.deepEqual(matches, [[], []]);
});

test('unique coordinate matches remain usable when unrelated operations have the same text', () => {
 const matches = matchTextOperations(
  [item('10.00', 10, 20)],
  [operation(1, '10.00', {x: 100, y: 100}), operation(2, '10.00', {x: 10, y: 20})],
 );
 assert.deepEqual(matches.map(group => group.map(op => op.index)), [[2]]);
});
