const colors = ['#407b68', '#ad7657', '#6780a7', '#9675a1', '#b28b38', '#548a93', '#b06172', '#74864f'];
export function workspaceColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}
