const titleEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

// Imported titles stay unchanged in storage. React renders the decoded value as text.
export function displayTitle(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lsquo|rsquo|ldquo|rdquo);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return titleEntities[code.toLowerCase()] ?? entity;
    const hexadecimal = code[1].toLowerCase() === 'x';
    const point = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
}
