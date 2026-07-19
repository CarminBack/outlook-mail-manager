export function parseOAuthImportEmails(content: string): { emails: string[]; invalidLines: number[] } {
  const emails: string[] = [];
  const invalidLines: number[] = [];
  const seen = new Set<string>();

  content.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const email = line.split(/----|\||\s+/, 1)[0].trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalidLines.push(index + 1);
      return;
    }
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  });

  return { emails, invalidLines };
}
