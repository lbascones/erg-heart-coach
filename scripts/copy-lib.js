// ErgometerJS is a classic global script (it defines `var ergometer`), not an ES module,
// so we serve it as a static file and load it with a <script> tag in index.html.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/lib', { recursive: true });
copyFileSync('node_modules/ergometer-js/api/lib/ergometer.js', 'public/lib/ergometer.js');
console.log('Copied ergometer.js to public/lib/');
