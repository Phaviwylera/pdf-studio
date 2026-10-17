const normalizeText = value => String(value ?? '').normalize('NFKC').replace(/\s/g, '');

/**
 * Match extracted text items to PDF showText operations without guessing. Spatial
 * matches win when uniquely close; reading order is only a safe fallback when
 * every item and every matching operation group forms an exact bijection.
 */
export function matchTextOperations(items, operations, {maxOperationsPerItem = 20} = {}) {
 const candidatesByItem = items.map(item => {
  const target = normalizeText(item.text);
  const candidates = operations.filter(operation => operation.fontId === item.fontId)
   .sort((a, b) => a.index - b.index);
  const groups = [];
  for (let start = 0; start < candidates.length; start++) {
   let text = '';
   const group = [];
   for (let end = start; end < Math.min(start + maxOperationsPerItem, candidates.length); end++) {
    const operation = candidates[end];
    text += normalizeText(operation.str);
    group.push(operation);
    if (text === target) {
     groups.push(group);
     break;
    }
    if (!target.startsWith(text)) break;
   }
  }
  return groups;
 });

 const chosen = items.map((item, itemIndex) => {
  const groups = candidatesByItem[itemIndex];
  const ranked = groups.map(group => {
   const box = group[0].bbox;
   const score = box && Number.isFinite(item.x) && Number.isFinite(item.y)
    ? Math.abs(box.x - item.x) + Math.abs(box.y - item.y)
    : Infinity;
   return {group, score};
  }).sort((a, b) => a.score - b.score);
  if (ranked.length === 1) return ranked[0].group;
  if (ranked.length > 1 && Number.isFinite(ranked[0].score)
    && ranked[0].score < (item.tolerance ?? 30)
    && ranked[0].score < ranked[1].score) return ranked[0].group;
  return null;
 });
 const chosenSets = chosen.map(group => new Set((group || []).map(operation => operation.index)));
 for (let i = 0; i < chosen.length; i++) {
  if (!chosen[i]) continue;
  if (chosenSets.some((set, j) => j !== i && [...chosenSets[i]].some(index => set.has(index)))) chosen[i] = null;
 }

 if (chosen.some(group => !group)) {
  const allGroups = candidatesByItem.flat();
  const byIdentity = new Map();
  for (const group of allGroups) {
   const key = group.map(operation => operation.index).join(',');
   if (!byIdentity.has(key)) byIdentity.set(key, group);
  }
  const uniqueGroups = [...byIdentity.values()];
  const operationSets = uniqueGroups.map(group => new Set(group.map(operation => operation.index)));
  const overlaps = operationSets.some((set, i) => operationSets.some((other, j) =>
   i !== j && [...set].some(index => other.has(index))));
  const orderedGroups = [...uniqueGroups].sort((a, b) => a[0].index - b[0].index);
  const canUseReadingOrder = items.length > 0
   && candidatesByItem.every(groups => groups.length > 0)
   && uniqueGroups.length === items.length
   && !overlaps
   && orderedGroups.every((group, i) => i === 0 || orderedGroups[i - 1].at(-1).index < group[0].index)
   && candidatesByItem.every((groups, i) => groups.some(group =>
    group.map(operation => operation.index).join(',') === orderedGroups[i].map(operation => operation.index).join(',')));
  if (canUseReadingOrder) return orderedGroups;
 }

 return chosen.map(group => group || []);
}
