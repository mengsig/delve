const technicalText = /(?:`[^`]+`|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b(?:[\w.-]+[/\\])*[\w-]+\.(?:ts|tsx|js|jsx|py|rs|json|ya?ml|md|toml|go|java|css|html)\b|\b\w{2,}(?:\.[a-zA-Z_]\w+)+\b|\b[a-z_$][\w$]*[A-Z][\w$]*\b|\b(?:function|class|const|let|var)\s+[\w$]+\s*[=(]|(?:=>|\b\w+\([^)]*\)))/;

export function containsTechnicalText(text: string): boolean {
  return technicalText.test(text);
}

export function plainConceptTitle(title: string): string {
  if (!containsTechnicalText(title)) return title;
  const plain = title.replace(new RegExp(technicalText.source, 'g'), ' ').replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/[\s:–—.,/()]+$/u, '').replace(/\s+(?:in|at|for|of|with|from|to|by)$/i, '');
  return /\p{L}/u.test(plain) ? plain.charAt(0).toUpperCase() + plain.slice(1) : 'Code details';
}
