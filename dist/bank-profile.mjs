// Statement layout profiles — one per bank, chosen per document.
//
// Every Indian bank prints its statement with its own idea of a money column.
// The union-bank files that shaped this editor draw each amount as "100.00(Dr)"
// right-aligned on one edge; the SBI files draw the figures with a fixed-width
// metric and write the direction straight after the figure ("14.43CR"), so the
// same column ends in four different places, and a direction suffix makes a
// value look a quarter of a millimetre wider than it is.
//
// A profile is not a detector of what to do to a page — it is the set of
// settings the page set is read with. It is kept with the document that was
// opened and never shared with the next one, so tuning for one bank cannot
// change how another bank's statement is exported.

export const DEFAULT_ALIGNMENT = {minSupport: 3, maxDrift: 8, band: 12, minMove: 0.1};

export const BANK_PROFILES = {
 auto: {
  id: 'auto',
  label: 'Detect automatically',
  note: 'Read the first pages and use the bank profile they match, or the generic one.',
  align: 'right',
  directionSuffix: false,
  // Only a profile that knows its printer leaves a column in several places
  // turns the whole-column pass on; everything else keeps the stray-only rule
  // the editor was tuned with.
  columnPass: false,
  alignment: {...DEFAULT_ALIGNMENT},
 },
 sbi: {
  id: 'sbi',
  label: 'State Bank of India',
  note: 'Figures are written with a fixed-width metric and a direction run straight after the figure ("14.43CR"). The column is aligned on the figure, not on the suffix, so 100s, 1000s and lakhs share one decimal point.',
  align: 'decimal',
  directionSuffix: true,
  columnPass: true,
  alignment: {...DEFAULT_ALIGNMENT},
 },
 union: {
  id: 'union',
  label: 'Union Bank of India',
  note: 'Amounts carry a bracketed direction ("100.00(Dr)") and sit on one right edge. The column is aligned on that edge, exactly as tuned for these statements.',
  align: 'right',
  directionSuffix: false,
  columnPass: false,
  alignment: {...DEFAULT_ALIGNMENT},
 },
 generic: {
  id: 'generic',
  label: 'Other / generic statement',
  note: 'Aligns a column on its right edge when one edge clearly owns it. Nothing else on the page is touched.',
  align: 'right',
  directionSuffix: false,
  columnPass: false,
  alignment: {...DEFAULT_ALIGNMENT},
 },
};

export const PROFILE_ORDER = ['auto', 'sbi', 'union', 'generic'];

// What a page set has to look like before it is called one bank's statement.
const SIGNATURES = {
 sbi: [
  /\bstatement of account\b/i,
  /\bstatement summary\b/i,
  /\bbrought forward\b/i,
  /\btotal debits?\b/i,
  /\btotal credits?\b/i,
  /\b(?:dr|cr)\.? count\b/i,
  /\b\d[\d,]*\.\d{2}(?:CR|DR)\b/,
  /\bstate bank of india\b/i,
 ],
 union: [
  /\(\s*dr\s*\)/i,
  /\(\s*cr\s*\)/i,
  /\bunion bank of india\b/i,
  /\bstatement of account\b/i,
  /\bwithdrawal\b/i,
  /\bdeposit\b/i,
 ],
};

/** Score a document against one bank's signatures. */
export function profileScore(profileId, text) {
 const patterns = SIGNATURES[profileId];
 if (!patterns) return 0;
 const source = String(text ?? '');
 return patterns.reduce((score, pattern) => score + (pattern.test(source) ? 1 : 0), 0);
}

/**
 * Name the bank a statement was printed by, reading only its own text. Two
 * signatures are needed before a bank is named: one line that every statement
 * carries is not enough to apply a bank's column rules to it.
 */
export function detectBankProfile(text, {threshold = 2} = {}) {
 const scores = Object.keys(SIGNATURES)
  .map(id => ({id, score: profileScore(id, text)}))
  .sort((a, b) => b.score - a.score);
 const best = scores[0];
 if (!best || best.score < threshold) return 'generic';
 // Two banks scoring the same means the page said nothing that separates them.
 if (scores[1] && scores[1].score === best.score) return 'generic';
 return best.id;
}

/** The profile a document is exported with: its own choice, or what it looks like. */
export function resolveProfile(choice, detected) {
 const picked = BANK_PROFILES[choice];
 if (picked && choice !== 'auto') return picked;
 return BANK_PROFILES[detected] || BANK_PROFILES.generic;
}

/** The options for the document's layout control. */
export function profileOptions() {
 return PROFILE_ORDER.map(id => ({value: id, label: BANK_PROFILES[id].label}));
}

/**
 * The number a money cell actually is, separate from the direction printed
 * after it: "14.43CR" is the number 14.43 and the suffix "CR". A column is
 * aligned on the number, so a suffix never shifts the figure off its column.
 */
export function splitDirection(text) {
 const source = String(text ?? '');
 const match = /^(.*?)(\s*(?:\(|\s)(?:dr|cr)\s*\)?|\s*(?:DR|CR|Dr|Cr|dr|cr)|)\s*$/i.exec(source);
 if (!match) return {number: source, suffix: ''};
 // Only a suffix that follows a figure counts; a word is not a direction.
 const number = match[1];
 const suffix = match[2];
 if (!/\d/.test(number) || !/(?:dr|cr)/i.test(suffix)) return {number: source, suffix: ''};
 return {number, suffix};
}

/** True when the figure of this cell would be measured differently without its suffix. */
// How much of a run's width belongs to the direction written after the figure.
// The editor's light blocks carry one width for the whole run, so the share is
// estimated from the shape of the text with standard type widths: a C is wider
// than a digit, a comma narrower. Only used to decide which column a value
// belongs to; the export measures the figure itself when it writes it.
const CHAR_WEIGHT = {
 digits: 0.556, '.': 0.278, ',': 0.278, '(': 0.333, ')': 0.333, ' ': 0.278,
 upper: 0.667, lower: 0.5, other: 0.5, slash: 0.278,
};
function charWeight(char) {
 if (/[0-9]/.test(char)) return CHAR_WEIGHT.digits;
 if (char === '/') return CHAR_WEIGHT.slash;
 if (/[A-Z]/.test(char)) return CHAR_WEIGHT.upper;
 if (/[a-z]/.test(char)) return CHAR_WEIGHT.lower;
 return CHAR_WEIGHT[char] ?? CHAR_WEIGHT.other;
}

/** The share of a run's width taken by its direction suffix, 0 when it has none. */
export function suffixWidthShare(text) {
 const {suffix, number} = splitDirection(String(text ?? ''));
 if (!suffix || !number) return 0;
 const total = [...String(text)].reduce((sum, char) => sum + charWeight(char), 0);
 const tail = [...suffix].reduce((sum, char) => sum + charWeight(char), 0);
 return total > 0 ? Math.min(1, tail / total) : 0;
}

export function hasDirectionSuffix(text) {
 const {suffix} = splitDirection(text);
 return suffix.length > 0;
}
