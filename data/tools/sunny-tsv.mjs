/** Read TSV from Python csv/pandas without corrupting quoted identities. */
export function parseQuotedTsv(text) {
  const records = [];
  let record = [], field = '', quoted = false, fieldStart = true;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; }
      else field += ch;
    } else if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; }
    else if (ch === '\t') { record.push(field); field = ''; fieldStart = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      record.push(field);
      if (record.some(cell => cell !== '')) records.push(record);
      record = []; field = ''; fieldStart = true;
    } else { field += ch; fieldStart = false; }
  }
  if (quoted) throw new Error('Unterminated quoted TSV field');
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  const header = records.shift();
  if (!header) return [];
  if (new Set(header).size !== header.length) throw new Error('Duplicate TSV columns');
  return records.map((values, index) => {
    if (values.length > header.length) throw new Error(`TSV row ${index + 2} has too many columns`);
    return Object.fromEntries(header.map((key, i) => [key, values[i] ?? '']));
  });
}
