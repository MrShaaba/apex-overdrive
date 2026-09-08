// Compact glTF structure dump: node path, material, tris, world bounds. Usage: node _dump.mjs <scene.gltf> [maxLines]
import fs from 'node:fs'
const [f, maxArg] = process.argv.slice(2); const max = Number(maxArg ?? 60)
const g = JSON.parse(fs.readFileSync(f, 'utf8'))
function mat4(n){ if(n.matrix) return n.matrix.slice(); const t=n.translation||[0,0,0],r=n.rotation||[0,0,0,1],s=n.scale||[1,1,1]; const [x,y,z,w]=r; const xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z; return [ (1-2*(yy+zz))*s[0], (2*(xy+wz))*s[0], (2*(xz-wy))*s[0],0, (2*(xy-wz))*s[1], (1-2*(xx+zz))*s[1], (2*(yz+wx))*s[1],0, (2*(xz+wy))*s[2], (2*(yz-wx))*s[2], (1-2*(xx+yy))*s[2],0, t[0],t[1],t[2],1]; }
const mul=(a,b)=>{const o=new Array(16).fill(0);for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)o[j*4+i]+=a[k*4+i]*b[j*4+k];return o}
const xf=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; const lines=[]; let total=0; const lo=[1e9,1e9,1e9],hi=[-1e9,-1e9,-1e9]
function walk(ni,pm,path){const n=g.nodes[ni];const m=mul(pm,mat4(n));const p=path+'/'+(n.name||'node'+ni)
  if(n.mesh!=null){for(const pr of g.meshes[n.mesh].primitives){const a=g.accessors[pr.attributes.POSITION];const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];for(const cx of [a.min[0],a.max[0]])for(const cy of [a.min[1],a.max[1]])for(const cz of [a.min[2],a.max[2]]){const q=xf(m,[cx,cy,cz]);for(let i=0;i<3;i++){mn[i]=Math.min(mn[i],q[i]);mx[i]=Math.max(mx[i],q[i]);lo[i]=Math.min(lo[i],q[i]);hi[i]=Math.max(hi[i],q[i])}}
    const tris=(pr.indices!=null?g.accessors[pr.indices].count:a.count)/3; total+=tris
    lines.push(p.replace(/^\/Sketchfab_model(\/root\/GLTF_SceneRootNode)?/,'').padEnd(56).slice(0,56)+' '+(g.materials[pr.material]||{name:'-'}).name.padEnd(22).slice(0,22)+' '+String(Math.round(tris)).padStart(7)+' ('+mn.map(v=>v.toFixed(2)).join(',')+')..('+mx.map(v=>v.toFixed(2)).join(',')+')')}}
  for(const c of n.children||[])walk(c,m,p)}
for(const r of g.scenes[g.scene||0].nodes)walk(r,I,'')
console.log(`# ${f}: nodes ${g.nodes.length} meshes ${g.meshes.length} materials ${g.materials.length} images ${(g.images||[]).length} tris ${Math.round(total)} bounds (${lo.map(v=>v.toFixed(2)).join(',')})..(${hi.map(v=>v.toFixed(2)).join(',')}) ext ${JSON.stringify(g.extensionsUsed||[])}`)
console.log(lines.slice(0,max).join('\n')); if(lines.length>max) console.log(`  ... +${lines.length-max} more`)
