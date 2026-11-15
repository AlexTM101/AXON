const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../src/Axon.Desktop/Web/scene-geometry.js');
const geometry = fs.existsSync(modulePath) ? require(modulePath) : {};

test('camera projects the graph origin and displaced node at the same point as DOM labels', () => {
  assert.equal(typeof geometry.screenPoint, 'function');
  const camera = {x: 490, y: 237, scale: 1.25};
  assert.deepEqual(geometry.screenPoint(camera, {x:0, y:0}), {x:490, y:237});
  assert.deepEqual(geometry.screenPoint(camera, {x:-72, y:40}), {x:400, y:287});
});

test('each visible edge terminates at its actual graph nodes and marks the full selected lineage', () => {
  assert.equal(typeof geometry.buildNetwork, 'function');
  const agents = ['r','a','b','c'].map(id => ({id, depth: id === 'r' ? 0 : 1}));
  const nodes = agents.map(({id}, i) => ({id, x:i*73, y:i%2*60}));
  const edges = [{from:'r',to:'a'},{from:'a',to:'b'},{from:'r',to:'c'},{from:'c',to:'hidden'}];
  const net = geometry.buildNetwork({nodes,edges}, agents, 'r', 'b');
  assert.equal(net.edges.length, 3);
  for (const [i, curve] of net.edges.entries()) {
    const from=nodes.find(n => n.id === edges[i].from), to=nodes.find(n => n.id === edges[i].to);
    assert.deepEqual(geometry.onCurve(curve, 0), {x:from.x,y:from.y});
    assert.deepEqual(geometry.onCurve(curve, 1), {x:to.x,y:to.y});
    assert.equal(curve.selected, i < 2);
  }
});

test('sculpture is reproducible, finite, bounded and occupies near and far hemispheres', () => {
  assert.equal(typeof geometry.createSculpture, 'function');
  const shape = geometry.createSculpture(), again = geometry.createSculpture();
  assert.deepEqual(shape, again);
  assert.equal(geometry.coreScale,1.65);
  assert.ok(shape.paths.length > 80 && shape.dust.length > 150);
  let near = 0, far = 0;
  for (const {xyz} of shape.paths) {
    for (let i=0; i<xyz.length; i+=3) {
      assert.ok(Number.isFinite(xyz[i] + xyz[i+1] + xyz[i+2]));
      assert.ok(Math.hypot(xyz[i],xyz[i+1],xyz[i+2]) <= 90.1);
      assert.ok(geometry.coreScale*Math.hypot(xyz[i],xyz[i+1]) < 148,
        'solid fibres leave the root label at world Y +148 clear');
      near += xyz[i+2] > 40;
      far += xyz[i+2] < -40;
    }
  }
  assert.ok(near > 100 && far > 100);
});

test('holding decorative time returns the same shape, advancing it turns local depth into screen motion', () => {
  assert.equal(typeof geometry.pose, 'function');
  const point = [63, -12, 47];
  const project = t => geometry.rotatePoint(...point, geometry.pose(t));
  assert.deepEqual(project(12000), project(12000));
  assert.ok(Math.hypot(project(0).x-project(4000).x, project(0).y-project(4000).y) > 1);
  const origin = geometry.rotatePoint(0,0,0,geometry.pose(13000));
  assert.equal(Math.hypot(origin.x, origin.y), 0);
});
