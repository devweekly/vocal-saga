const fs = require('fs');
const html = fs.readFileSync('temp/x-deedydas-raw.html', 'utf8');
const external = html.match(/<script\b[^>]*src="([^"]+)"[^>]*>/gi) || [];
console.log('External scripts:');
external.forEach((s) => console.log('  ', s));
const inline = html.match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
console.log('\nInline scripts count:', inline.length);
inline.forEach((s, i) => {
  const snippet = s.slice(0, 300).replace(/\n/g, ' ');
  console.log(i, snippet);
});
