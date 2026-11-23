const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = process.argv[2], target = process.argv[3];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function plainDirectory(p) {
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Unsafe directory: ' + p);
}
plainDirectory(source); plainDirectory(target);
const files = [];
function collect(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const relative = prefix + entry.name, p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symlink asset rejected: ' + relative);
    if (entry.isDirectory()) collect(p, relative + '/');
    else if (entry.isFile()) {
      const data = fs.readFileSync(p);
      files.push({name:relative, sha256:hash(data), data});
    } else throw Error('Unsupported asset: ' + relative);
  }
}
collect(source);
if (!files.length) throw Error('Empty release assets');
// Check every existing file before publishing anything; old chunks stay available.
for (const file of files) {
  const components = file.name.split('/'); let parent = target;
  for (const component of components.slice(0,-1)) {
    parent = path.join(parent,component);
    if (fs.existsSync(parent)) plainDirectory(parent);
  }
  const dest = path.join(target, file.name);
  try {
    const stat = fs.lstatSync(dest);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(dest)) !== file.sha256)
      throw Error('Asset name collision: ' + file.name);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
let added=0;
for (const file of files) {
  const dest=path.join(target,file.name);
  if (fs.existsSync(dest)) continue;
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  const temp=dest+'.publish-'+crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp,file.data,{flag:'wx',mode:0o644});
    // Hard link publishes a complete file without replacing an existing chunk.
    fs.linkSync(temp,dest); added++;
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
console.log(JSON.stringify({added,files:files.map(({name,sha256})=>({name,sha256}))}));
