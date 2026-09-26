import { makeIO } from './io.mjs';
const io = await makeIO();
for (const p of process.argv.slice(2)) {
  const doc = await io.read(p);
  const root = doc.getRoot();
  console.log('=====', p);
  const printNode = (n, d) => {
    const m = n.getMesh();
    const isJoint = root.listSkins().some(s => s.listJoints().includes(n));
    if (!isJoint || d < 3 || n.getName().match(/^(Hips|Spine3|Head|Left(Arm|UpLeg|Foot|Hand)|DEF-(spine|thigh.L|foot.L|upper_arm.L|hand.L|spine.006))$/))
      console.log(' '.repeat(d*2) + n.getName(), 'T', n.getTranslation().map(v=>+v.toFixed(3)), 'R', n.getRotation().map(v=>+v.toFixed(3)), 'S', n.getScale().map(v=>+v.toFixed(3)), m ? 'MESH '+m.getName() : '', n.getSkin() ? 'SKIN' : '');
    n.listChildren().forEach(c => printNode(c, d+1));
  };
  root.listScenes()[0].listChildren().forEach(n => printNode(n, 0));
  for (const m of root.listMeshes()) for (const pr of m.listPrimitives()) {
    const pos = pr.getAttribute('POSITION');
    console.log('mesh', m.getName(), 'verts', pos.getCount(), 'idx', pr.getIndices()?.getCount(), 'min', pos.getMin([]).map(v=>+v.toFixed(3)), 'max', pos.getMax([]).map(v=>+v.toFixed(3)), 'mat', pr.getMaterial()?.getName(), 'targets', pr.listTargets().length);
  }
}
