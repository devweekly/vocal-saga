import { parseHTML } from 'linkedom';

const { document: doc } = parseHTML('<div contenteditable="false"><span>text</span></div>') as unknown as { document: Document };
const div = doc.querySelector('div')!;
const span = doc.querySelector('span')!;
console.log('div contenteditable attr:', div.getAttribute('contenteditable'));
console.log('div isContentEditable:', (div as HTMLElement).isContentEditable);
console.log('span isContentEditable:', (span as HTMLElement).isContentEditable);

const { document: doc2 } = parseHTML('<div contenteditable="true"><span>text</span></div>') as unknown as { document: Document };
const div2 = doc2.querySelector('div')!;
const span2 = doc2.querySelector('span')!;
console.log('div2 contenteditable attr:', div2.getAttribute('contenteditable'));
console.log('div2 isContentEditable:', (div2 as HTMLElement).isContentEditable);
console.log('span2 isContentEditable:', (span2 as HTMLElement).isContentEditable);
