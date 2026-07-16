const fs = require('fs');
const html = fs.readFileSync('temp/x-deedydas-raw.html', 'utf8');
const inline = html.match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
if (!fs.existsSync('temp/scripts_dump')) fs.mkdirSync('temp/scripts_dump');
inline.forEach((s, i) => {
  fs.writeFileSync(`temp/scripts_dump/inline_${i}.txt`, s);
});
console.log('Dumped', inline.length, 'inline scripts');
