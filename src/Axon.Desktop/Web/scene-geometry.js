/* Shared three-dimensional model for the GPU and software renderers; Y points down. */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const coreScale = 1.65;
  const spectrum = ['#64dfff','#95beff','#ad93ff','#ed83d7','#eef6ff','#718ada'];
  const stateColors = {completed:'#a1d7b5', error:'#eea0a5', interrupted:'#f1bd85', started:'#7be4e8', tool:'#7be4e8'};

  function randomSource(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }
  function sphere(longitude, latitude, radius) {
    const r = radius * Math.cos(latitude);
    return [r * Math.cos(longitude), radius * Math.sin(latitude), r * Math.sin(longitude)];
  }
  function sample(count, fn) {
    const xyz = new Float32Array((count + 1) * 3);
    for (let i = 0; i <= count; i++) xyz.set(fn(i / count), i * 3);
    return xyz;
  }
  function pose(ms) {
    const yaw = ms * .000082 + .12;
    const pitch = -.14 + .10 * Math.sin(ms * .00023);
    return {yaw, pitch, cy:Math.cos(yaw), sy:Math.sin(yaw), cx:Math.cos(pitch), sx:Math.sin(pitch)};
  }
  function rotatePoint(x, y, z, p) {
    const depth = -x * p.sy + z * p.cy;
    return {x:x*p.cy + z*p.sy, y:y*p.cx - depth*p.sx, z:y*p.sx + depth*p.cx};
  }

  function createSculpture() {
    const rng = randomSource(0x64726f70), paths = [], dust = [];
    function stroke(layer, ink, opacity, count, fn) {
      paths.push({layer, ink, opacity, xyz:sample(count, fn)});
    }
    // Axon bundles twist together inside the soma and fan into separate nerve tips.
    for (let i=0; i<25; i++) {
      const meridian = i * 2.399963, lat = Math.asin((i+.5)/25*2-1);
      const bend = (rng()-.46)*2.5, kink = rng()*TAU;
      for (let j=0; j<8; j++) {
        const split = (rng()-.5)*.90, tip = (rng()-.5)*.65;
        const offset = rng()*.08, radius = 68+rng()*10;
        const ink = j===0 ? 4 : Math.floor(rng()*4);
        stroke('nerve',ink,j===0?.46:.085+rng()*.12,23,t => {
          const fan = Math.max(0,(t-.35)/.65)**1.4;
          const longitude = meridian + bend*(1-t)**1.8 + .22*Math.sin(t*7+kink)*(1-t) + split*fan+offset;
          const latitude = lat+.56*Math.sin(t*4.4+kink)*(1-t)+tip*fan;
          return sphere(longitude,latitude,3+radius*t);
        });
      }
    }
    // Fine folded sheets run along the surface. Neighboring fibres share folds and
    // separate at the ends, leaving dark windows through which the interior reads.
    for (let patch=0; patch<9; patch++) {
      const phi = patch*2.39996, start = rng()*TAU, span = 2.9+rng()*2.3;
      const latitude = (rng()-.5)*1.95, twist = .36+rng()*.5;
      for (let thread=0; thread<16; thread++) {
        const s=(thread-7.5)/15, drift=rng()*.027, ink=thread%7===0?4:(patch+Math.floor(thread/7))%4;
        stroke('fold',ink,.105+rng()*.19,44,t => {
          const a = start+t*span;
          const width = .19+.40*Math.sin(t*Math.PI)**2;
          const lat = latitude + twist*Math.sin(1.72*a+phi) + .14*Math.sin(3.2*a+phi+s) + s*width;
          const r = 70+5*Math.cos(2.3*a+phi+s)+2.8*Math.sin(a*4-lat+s*.6);
          return sphere(a+.30*Math.sin(lat*3+phi)+s*.15+drift,lat,r);
        });
      }
    }
    // A discontinuous silver reticulum. Edges join actual neighbors of a jittered
    // spherical lattice, avoiding long chords which read as a wireframe ball.
    const cells=[];
    for (let i=0; i<330; i++) {
      const lon=i*2.399963+(rng()-.5)*.14, lat=Math.asin(2*(i+.5)/330-1)+(rng()-.5)*.10;
      cells.push(sphere(lon,lat,71+rng()*5));
    }
    cells.forEach((a,i) => {
      for (const jump of [13,21,34]) {
        const b=cells[i+jump];
        if (!b || Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])>20 || rng()<.44) continue;
        stroke('membrane', i%5, .08+rng()*.15, 1,t => t===0?a:b);
      }
    });
    // Distinct inclinations place the glass-like orbital traces on separate planes.
    const orbits=[[.27,-.98,87,0.2,5.7],[-.62,.81,83,-.6,5.4],[1.04,-.44,84,1.3,4.8]];
    for (const [tilt, incline, r, start, arc] of orbits) {
      for (let band=0; band<2; band++) {
        const rad=r-band*.8;
        stroke('orbit',band?3:1,band?.13:.39,100,t => {
          const a=start+t*arc, x=rad*Math.cos(a), y=rad*Math.sin(a)*Math.cos(incline);
          return [x*Math.cos(tilt)-y*Math.sin(tilt), x*Math.sin(tilt)+y*Math.cos(tilt),rad*Math.sin(a)*Math.sin(incline)];
        });
      }
    }
    for (let i=0; i<1250; i++) {
      const lon=rng()*TAU, lat=Math.asin(rng()*2-1);
      const r = i%7===0 ? 79+rng()*10 : (i%4===0 ? 24+rng()*48 : 70+rng()*8);
      const [x,y,z]=sphere(lon,lat,r);
      dust.push({x,y,z,ink:i%5, size:i%37===0?1.75+rng():.36+rng()*.82, opacity:.23+rng()*.64});
    }
    return {paths,dust};
  }

  function screenPoint(camera, {x,y}) {
    return {x:x*camera.scale+camera.x, y:y*camera.scale+camera.y};
  }
  function buildNetwork(graph, agents, rootId, selectedId) {
    const agentById=new Map(agents.map(a => [a.id,a]));
    const nodes=new Map(graph.nodes.map(n => {
      const a=agentById.get(n.id) || {};
      return [n.id,{x:n.x,y:n.y,id:n.id,root:n.id===rootId,selected:n.id===selectedId,
        radius:a.depth>1?5.3:7, color:stateColors[a.state]||'#bcb2ea', stale:a.freshness==='stale'}];
    }));
    const parentOf=new Map(graph.edges.map(e => [e.to,e.from]));
    const path=new Set();
    for (let id=selectedId; nodes.has(id)&&!path.has(id); id=parentOf.get(id)) path.add(id);
    const edges=[], byChild=new Map();
    for (const e of graph.edges) {
      const a=nodes.get(e.from), b=nodes.get(e.to);
      if (!a || !b || a===b) continue;
      const dx=b.x-a.x,dy=b.y-a.y, length=Math.hypot(dx,dy) || 1;
      const nx=-dy/length, ny=dx/length;
      const bow=Math.min(length*.19,51)*(dx+dy*.4 < 0 ? -1 : 1);
      const curve={a,b,nx,ny,cx:a.x+dx*.43+nx*bow,cy:a.y+dy*.43+ny*bow,selected:path.has(b.id)&&parentOf.get(b.id)===a.id};
      edges.push(curve); byChild.set(b.id,curve);
    }
    return {nodes,edges,byChild,root:nodes.get(rootId)};
  }
  function onCurve({a,b,cx,cy,nx,ny}, t, separation=0) {
    const u=1-t, fan=separation*Math.sin(Math.PI*t)**2 * Math.sin(3.5*t+.5);
    return {x:u*u*a.x+2*u*t*cx+t*t*b.x+nx*fan, y:u*u*a.y+2*u*t*cy+t*t*b.y+ny*fan};
  }
  const api={createSculpture,pose,rotatePoint,screenPoint,buildNetwork,onCurve,spectrum,coreScale};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else window.AxonSceneGeometry=api;
})();
