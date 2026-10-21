import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'demo-samples');
fs.mkdirSync(out, { recursive: true });

const pdfWith = (marker) => `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${marker} >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;

const samples = [
  ['tax-form-with-script.pdf', pdfWith('/JavaScript 3 0 R /OpenAction 3 0 R')],
  ['logo-with-script.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>/* demo marker, does nothing */</script><rect width="64" height="64" fill="currentColor"/></svg>\n'],
  ['holiday-photo.png', pdfWith('/JavaScript 3 0 R')],
  ['statement.pdf.exe', 'This is only text. It is not a program.\n'],
];

for (const [name, content] of samples) fs.writeFileSync(path.join(out, name), content, 'utf8');
console.log(`Wrote ${samples.length} harmless sample files to ${path.relative(process.cwd(), out) || out}:`);
for (const [name] of samples) console.log(`  ${name}`);
console.log('Upload them in Warden to see them held in Quarantine. No antivirus test file is created.');
