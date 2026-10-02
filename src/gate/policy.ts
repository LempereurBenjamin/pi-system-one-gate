const signals = [
  /\b(?:error|fatal|fail(?:ed|ure|ures)?|exception|traceback|assertion(?:error)?)\b/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|\w+Exception)\b/,
  /^\s+at\s+.+(?:\:\d+|\(.*\))/m,
  /^(?:<{7}|={7}|>{7})(?:\s|$)/m,
  /\b(?:merge conflicts?|CONFLICT|CVE-\d{4}-\d+)\b/i,
  /\b(?:security|vulnerabilit\w*|unsafe|migration|compiler)\b.*\b(?:warn\w*|critical|abort\w*|denied|conflict\w*)\b/i,
  /\b(?:warn\w*|critical)\b.*\b(?:security|vulnerabilit\w*|unsafe)\b/i,
];

export function mustKeep(text: string): boolean {
  return signals.some(pattern => pattern.test(text));
}
