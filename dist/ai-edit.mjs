// AI edit: a prompt becomes a list of value changes, and nothing else.
//
// The model never receives the PDF, its fonts, its metadata or its file
// identifier — only the rows the statement check already reads. It never
// returns a layout either: it names a row, a field and a value, and this module
// turns that into a replacement for one existing text run. Every other property
// of that run — font, size, colour, spacing, position, the count of cells, the
// metadata — is carried over untouched, so an AI edit is the same kind of edit
// a person makes by clicking a cell.
//
// The formatting guarantee is enforced here, not asked for in the prompt: a
// returned number is parsed and re-rendered with the shape of the cell it
// replaces (grouping, decimals, Dr/Cr style), so a model that answers
// "Rs 1,00,234.5" still writes "1,00,234.50" in this statement's own hand.

import {parseAmount, parseDate, formatAmountLike} from './statement-check.mjs';

// ---------------------------------------------------------------------------
// Providers
//
// "Free" here means free of charge at the time of writing: Gemini has a free
// tier for its Flash models, Groq and OpenRouter have free tiers and free
// models, and Ollama runs on the user's own machine with no account at all. The
// key never leaves this browser tab: it is held in memory, sent only to the
// endpoint chosen here, and dropped when the tab closes.

export const PROVIDERS = {
 gemini: {
  id: 'gemini', shape: 'gemini', keyOptional: false,
  label: 'Google Gemini — free tier',
  hint: 'A free API key from aistudio.google.com. The free tier is rate limited, not paid.',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash',
 },
 groq: {
  id: 'groq', shape: 'openai', keyOptional: false,
  label: 'Groq — free tier',
  hint: 'A free API key from console.groq.com. Fast, and generous free limits.',
  endpoint: 'https://api.groq.com/openai/v1',
  model: 'llama-3.3-70b-versatile',
 },
 openrouter: {
  id: 'openrouter', shape: 'openai', keyOptional: false,
  label: 'OpenRouter — free models',
  hint: 'A key from openrouter.ai; a model whose name ends in “:free” costs nothing.',
  endpoint: 'https://openrouter.ai/api/v1',
  model: 'meta-llama/llama-3.3-70b-instruct:free',
 },
 ollama: {
  id: 'ollama', shape: 'openai', keyOptional: true,
  label: 'Ollama on this computer — no account',
  hint: 'Nothing leaves your machine. Start it with OLLAMA_ORIGINS=* so this page may call it.',
  endpoint: 'http://localhost:11434/v1',
  model: 'llama3.1',
 },
 openai: {
  id: 'openai', shape: 'openai', keyOptional: false,
  label: 'OpenAI (paid)',
  hint: 'A paid key from platform.openai.com.',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
 },
 custom: {
  id: 'custom', shape: 'openai', keyOptional: true,
  label: 'Other OpenAI-compatible endpoint',
  hint: 'Any server that speaks /chat/completions, including your own proxy.',
  endpoint: '',
  model: '',
 },
};

export const PROVIDER_ORDER = ['gemini', 'groq', 'openrouter', 'ollama', 'openai', 'custom'];

export function providerById(id) {
 return PROVIDERS[id] || PROVIDERS.gemini;
}

// What may be sent. The row list is the smallest thing that can still answer a
// question about a statement; the page text is offered for completeness only.
export const SCOPES = {
 values: {id: 'values', label: 'Values only — date, amount, balance', sends: 'one line per row: date, amount, balance'},
 rows: {id: 'rows', label: 'Values and narration — one line per row', sends: 'one line per row: date, narration, amount, balance'},
};
export const SCOPE_ORDER = ['values', 'rows'];

// What may be changed. A change is always one existing cell; the count, order
// and layout of the page are never part of a plan.
export const TARGETS = {
 money: {id: 'money', label: 'Amounts and balances', fields: ['amount', 'balance']},
 money_dates: {id: 'money_dates', label: 'Amounts, balances and dates', fields: ['amount', 'balance', 'date']},
 any: {id: 'any', label: 'Amounts, balances, dates and narration', fields: ['amount', 'balance', 'date', 'narration']},
};
export const TARGET_ORDER = ['money', 'money_dates', 'any'];

export const MAX_CHANGES = 500;

// ---------------------------------------------------------------------------
// The request

export const SYSTEM_PROMPT = [
 'You edit rows of a bank statement.',
 'Reply with JSON only, no prose and no code fence:',
 '{"changes":[{"row":<row number>,"field":"amount|balance|date|narration","value":"<new text>","reason":"<short reason>"}]}',
 'Rules:',
 '- Use only row numbers from the list you are given, and only the fields the user allows.',
 '- Change nothing you were not asked to change. An empty list is a valid answer.',
 '- "value" is the cell text: digits and separators for money, the date in the same shape as the old one, plain words for narration.',
 '- Never add or remove rows, and never invent a row number.',
].join('\n');

/** One line per row: the least text that can still answer a question about it. */
export function describeRows(rows, cells, {scope = 'rows'} = {}) {
 const withNarration = scope !== 'values';
 return rows.map((row, index) => {
  const amount = cellText(cells, index, 'amount');
  const balance = cellText(cells, index, 'balance');
  const date = cellText(cells, index, 'date');
  const narration = String(row.narration || '').replace(/\s+/g, ' ').trim();
  return withNarration
   ? `${index}|${date}|${narration}|${amount}|${balance}`
   : `${index}|${date}|${amount}|${balance}`;
 });
}

function cellText(cells, rowIndex, field) {
 const cell = (cells || []).find(entry => entry.row === rowIndex && entry.field === field);
 return cell ? String(cell.text ?? '') : '';
}

export function buildPrompt({rows, cells, scope = 'rows', targets = 'any', instruction = ''}) {
 const withNarration = scope !== 'values';
 return [
  withNarration
   ? 'Rows of this statement, one per line:\nrow|date|narration|amount|balance'
   : 'Rows of this statement, one per line:\nrow|date|amount|balance',
  describeRows(rows, cells, {scope}).join('\n'),
  '',
  `Fields you may change: ${(TARGETS[targets] || TARGETS.any).fields.join(', ')}.`,
  `Instruction: ${String(instruction || '').trim()}`,
 ].join('\n');
}

/** The exact HTTP request for a provider, so the caller only has to send it. */
export function buildRequest({provider = 'gemini', endpoint = '', model = '', key = '', prompt = '', system = SYSTEM_PROMPT} = {}) {
 const preset = providerById(provider);
 const base = String(endpoint || preset.endpoint || '').replace(/\/+$/, '');
 const chosen = String(model || preset.model || '').trim();
 if (!base) throw new Error('Choose an endpoint for this provider.');
 if (!chosen) throw new Error('Choose a model for this provider.');
 if (!preset.keyOptional && !String(key || '').trim()) throw new Error(`Enter the API key for ${preset.label}.`);
 if (preset.shape === 'gemini') {
  return {
   url: `${base}/models/${encodeURIComponent(chosen)}:generateContent`,
   init: {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-goog-api-key': String(key || '').trim()},
    body: JSON.stringify({
     systemInstruction: {parts: [{text: system}]},
     contents: [{role: 'user', parts: [{text: prompt}]}],
     generationConfig: {temperature: 0, responseMimeType: 'application/json'},
    }),
   },
  };
 }
 const headers = {'content-type': 'application/json'};
 if (String(key || '').trim()) headers.authorization = `Bearer ${String(key).trim()}`;
 return {
  url: `${base}/chat/completions`,
  init: {
   method: 'POST',
   headers,
   body: JSON.stringify({
    model: chosen,
    temperature: 0,
    messages: [{role: 'system', content: system}, {role: 'user', content: prompt}],
    response_format: {type: 'json_object'},
   }),
  },
 };
}

/** The text out of the reply, whichever provider answered. */
export function replyText(payload) {
 if (!payload) return '';
 // Gemini
 const parts = payload.candidates?.[0]?.content?.parts;
 if (Array.isArray(parts)) return parts.map(part => part?.text || '').join('');
 // OpenAI-compatible
 const content = payload.choices?.[0]?.message?.content;
 if (typeof content === 'string') return content;
 if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
 return '';
}

/**
 * Read the plan out of a model reply. Models wrap JSON in fences and prose even
 * when told not to, so the outermost object or array is taken and nothing else.
 */
export function parsePlan(text) {
 const source = String(text || '').trim();
 if (!source) throw new Error('The model returned an empty reply.');
 const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
 const body = fenced ? fenced[1] : source;
 const candidates = [body];
 const first = body.search(/[[{]/);
 if (first > 0) candidates.push(body.slice(first));
 let lastError = null;
 for (const candidate of candidates) {
  const sliced = candidate.slice(0, candidate.lastIndexOf(candidate.trim().startsWith('[') ? ']' : '}') + 1);
  for (const value of [sliced, candidate]) {
   try {
    const parsed = JSON.parse(value);
    const changes = Array.isArray(parsed) ? parsed : parsed.changes ?? parsed.edits ?? parsed.updates;
    if (Array.isArray(changes)) return changes;
    if (parsed && typeof parsed === 'object') throw new Error('The reply had no "changes" list.');
   } catch (error) {
    lastError = error;
   }
  }
 }
 throw new Error(`The model did not answer with JSON changes${lastError ? ` (${lastError.message})` : ''}. Nothing was changed.`);
}

// ---------------------------------------------------------------------------
// Cells and validation

const MONEY_FIELDS = new Set(['amount', 'balance']);

/**
 * The cells a plan may address. One per row, and each carries the exact text it
 * replaces: the shape of that text is what a new value is rendered in.
 */
export function planCells(rows, blocksByPage, {targets = 'any'} = {}) {
 const fields = new Set((TARGETS[targets] || TARGETS.any).fields);
 const cells = [];
 rows.forEach((row, rowIndex) => {
  const pageBlocks = blocksByPage.get ? blocksByPage.get(row.page) : blocksByPage[row.page];
  const add = (field, blockId, text) => {
   if (!blockId || !fields.has(field)) return;
   cells.push({row: rowIndex, field, id: blockId, page: row.page, text: String(text ?? '')});
  };
  if (row.amount) add('amount', row.amount.blockId, row.amount.text);
  if (row.balance) add('balance', row.balance.blockId, row.balance.text);
  const dateBlock = dateBlockFor(row, pageBlocks);
  if (dateBlock) add('date', dateBlock.id, dateBlock.text);
  if (fields.has('narration') && row.narrationBlock) add('narration', row.narrationBlock.id, row.narrationBlock.text);
 });
 return cells;
}

/** The date run of a row: the block on that line whose text parses as a date. */
export function dateBlockFor(row, blocks) {
 if (!row || !Array.isArray(blocks)) return null;
 const line = (blocks || []).filter(block => block && Math.abs(Number(block.y) - Number(row.y)) <= 1 && parseDate(block.text));
 if (!line.length) return null;
 return line.sort((a, b) => Number(a.x) - Number(b.x))[0];
}

/** A number out of whatever the model wrote, or null. */
export function numberFrom(value) {
 const text = String(value ?? '').trim();
 if (!text) return null;
 // "01/04/2026" is a date: the digits are not money, whatever they are worth.
 if (parseDate(text)) return null;
 const parsed = parseAmount(text);
 if (parsed && Number.isFinite(parsed.value)) return parsed.value;
 const cleaned = text.replace(/[^0-9.,\-+]/g, '').replace(/,/g, '');
 if (!cleaned) return null;
 const number = Number(cleaned);
 return Number.isFinite(number) ? number : null;
}

/** Write a date in the shape the cell already uses. */
export function formatDateLike(sample, value) {
 const parsed = parseDate(String(value ?? '').trim());
 if (!parsed) return null;
 const style = String(sample ?? '').trim();
 if (!style) return null;
 const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 const comma = style.includes(',');
 // "01-Apr-2026", "2 Feb 2026", "Apr 01, 2026": the separators and the order are
 // the cell's, only the date is new.
 const named = /[A-Za-z]{3}/.test(style);
 if (named) {
  const bare = style.replace(/,/g, '');
  const tokens = bare.split(/([\s./-]+)/).filter(Boolean);
  const sep = tokens.find((token, index) => index % 2 === 1) || ' ';
  const upcase = /^[A-Z]{3}$/.test(bare.match(/[A-Za-z]{3}/)?.[0] || '');
  const month = upcase ? months[parsed.month - 1].toUpperCase() : months[parsed.month - 1];
  const padded = /(^|[^\d])0\d/.test(bare);
  const day = padded ? String(parsed.day).padStart(2, '0') : String(parsed.day);
  const leading = /^[A-Za-z]/.test(bare);
  const parts = leading ? [month, day, String(parsed.year)] : [day, month, String(parsed.year)];
  return parts.join(sep) + (comma ? ',' : '');
 }
 const separator = style.includes('/') ? '/' : style.includes('.') ? '.' : style.includes('-') ? '-' : '/';
 const padded = /(^|[^\d])0\d/.test(style);
 const pad = number => (padded ? String(number).padStart(2, '0') : String(number));
 if (/^\d{4}/.test(style)) return [parsed.year, pad(parsed.month), pad(parsed.day)].join(separator);
 return [pad(parsed.day), pad(parsed.month), parsed.year].join(separator);
}

/** The new text for a cell, in that cell's own shape. */
export function formattedValue(cell, raw) {
 const draft = String(raw ?? '').trim();
 if (!draft) return null;
 if (MONEY_FIELDS.has(cell.field)) {
  const number = numberFrom(draft);
  if (number === null || !Number.isFinite(number)) return null;
  // The direction written in the cell follows the signed value, so a model may
  // answer "-45" or "45 DR" and get this bank's notation either way.
  return formatAmountLike(cell.text, number);
 }
 if (cell.field === 'date') return formatDateLike(cell.text, draft);
 // Narration is text: keep it one line, and nothing that would open a second run.
 const line = draft.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
 return line ? line.slice(0, 160) : null;
}

/**
 * Turn a model's plan into the changes that may actually be made. Everything the
 * model is not allowed to do is dropped here with a reason, so a bad answer can
 * only ever leave the page alone.
 */
export function validatePlan(changes, cells, {targets = 'any', limit = MAX_CHANGES} = {}) {
 const fields = new Set((TARGETS[targets] || TARGETS.any).fields);
 const byRowField = new Map(cells.map(cell => [`${cell.row}\u0000${cell.field}`, cell]));
 const accepted = [], rejected = [], seen = new Set();
 const list = Array.isArray(changes) ? changes : [];
 list.slice(0, limit * 4).forEach((change, index) => {
  if (accepted.length >= limit) return;
  const row = Number(change?.row);
  const field = String(change?.field ?? '').trim().toLowerCase();
  if (!Number.isInteger(row)) { rejected.push({index, reason: 'the row is not a number'}); return; }
  if (!fields.has(field)) { rejected.push({index, reason: `this run may not change ${field || 'that field'}`}); return; }
  const cell = byRowField.get(`${row}\u0000${field}`);
  if (!cell) { rejected.push({index, reason: `row ${row} has no ${field} cell here`}); return; }
  const key = `${row}\u0000${field}`;
  const text = formattedValue(cell, change?.value);
  if (text === null) { rejected.push({index, reason: `“${String(change?.value ?? '').slice(0, 24)}” is not a value this ${field} cell can hold`}); return; }
  if (text === cell.text) { rejected.push({index, reason: 'the value is already that'}); return; }
  if (seen.has(key)) { rejected.push({index, reason: `row ${row} ${field} was changed twice`}); return; }
  seen.add(key);
  accepted.push({...cell, text, from: cell.text, reason: String(change?.reason ?? '').slice(0, 160)});
 });
 return {accepted, rejected: rejected.slice(0, 20)};
}

/** The edit blocks for an accepted plan: only `text` differs from the original. */
export function applyPlan(accepted, currentBlock) {
 const edits = [];
 for (const change of accepted) {
  const block = currentBlock(change.id);
  if (!block || block.removed) continue;
  edits.push({...block, text: change.text});
 }
 return edits;
}
