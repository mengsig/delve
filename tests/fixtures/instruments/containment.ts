// These programs are inputs to the instrument interpreter.
export const hostilePrograms = {
  network: 'fetch("data:text/plain,probe")',
  filesystem: 'require("node:fs")',
  ipc: 'delve.invoke("workspaces:list", null)',
  parent: 'parent.document.title',
  navigation: 'location.assign("about:blank")',
  permission: 'navigator.permissions.query({name:"geolocation"})',
  download: 'document.createElement("a")',
  storage: 'localStorage.length',
  main: 'process.cwd()',
  loop: 'for (;;) {}',
  heap: 'new Array(500000).fill(1)',
  output: 'return {text: "x".repeat(65536), controls: [], marks: []}',
  flood: 'for (let i = 0; i < 64; i++) postMessage({ kind: "input" })',
  forgedEvidence: 'return {text:"Finished", controls:[], marks:[], demonstrated:true}',
} as const;
