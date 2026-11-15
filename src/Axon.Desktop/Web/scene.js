(() => {
  'use strict';
  const G = window.AxonSceneGeometry;
  const SPAN = 1900;
  function rgb(hex) {
    const n=parseInt(hex.slice(1),16);
    return [(n>>16)/255, ((n>>8)&255)/255, (n&255)/255];
  }
  function visitPulses(frame, net, emit) {
    if (frame.reducedMotion) return;
    for (const pulse of frame.pulses) {
      const t=(frame.now-pulse.start)/SPAN;
      if (t<0 || t>=1) continue;
      const target=net.nodes.get(pulse.agentId);
      if (!target) continue;
      const edge=net.byChild.get(target.id);
      const pos=edge ? G.onCurve(edge,t) : target;
      emit(pos.x,pos.y,Math.sin(Math.PI*t),target.color);
    }
  }

  // Software projection uses the same 3D paths as the GPU. Ink is batched by
  // material and local depth instead of allocating a gradient per fibre.
  function makeCanvasRenderer(canvas, model) {
    let ctx;
    try {ctx=canvas.getContext('2d');} catch {ctx=null;}
    let ratio=1, width=0, height=0;
    function glow(x,y,r,stops) {
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      for (const [p,color] of stops) g.addColorStop(p,color);
      ctx.fillStyle=g; ctx.fillRect(x-r,y-r,2*r,2*r);
    }
    function drawCore(node,phase,scale,quality) {
      ctx.save();ctx.translate(node.x,node.y);ctx.scale(G.coreScale,G.coreScale);
      const drawingScale=scale*G.coreScale;
      const exposure=Math.min(1,Math.max(.27,.75*drawingScale));
      glow(0,0,104,[[0,'#6777c644'],[.48,'#697aaf14'],[.73,'#6d6aa820'],[1,'#34385e00']]);
      const buckets=new Map();
      for (let k=0;k<model.paths.length;k++) {
        const path=model.paths[k];
        if (quality==='balanced' && k%3===1 && path.layer!=='orbit') continue;
        const v=path.xyz, mid=3*Math.floor(v.length/6);
        const depth=v[mid+1]*phase.sx+(-v[mid]*phase.sy+v[mid+2]*phase.cy)*phase.cx;
        const highlight=node.selected && path.layer==='orbit'?1.42:1;
        const light=Math.max(1,Math.min(12,Math.round(path.opacity*highlight*(.63+.004*depth)*19)));
        const key=path.ink*16+light;
        let batch=buckets.get(key);
        if (!batch) {batch=new Path2D(); buckets.set(key,batch);}
        for (let i=0;i<v.length;i+=3) {
          const z=-v[i]*phase.sy+v[i+2]*phase.cy;
          const px=v[i]*phase.cy+v[i+2]*phase.sy, py=v[i+1]*phase.cx-z*phase.sx;
          if (!i) batch.moveTo(px,py);
          else batch.lineTo(px,py);
        }
      }
      ctx.lineWidth=.80/Math.max(.85,drawingScale);
      for (const [key,batch] of buckets) {
        ctx.strokeStyle=G.spectrum[Math.floor(key/16)]; ctx.globalAlpha=(key%16)/19*exposure; ctx.stroke(batch);
      }
      for (let i=0;i<model.dust.length;i+=quality==='full'?1:2) {
        const d=model.dust[i], z=-d.x*phase.sy+d.z*phase.cy;
        const px=d.x*phase.cy+d.z*phase.sy, py=d.y*phase.cx-z*phase.sx;
        const r=d.size*.56, depth=d.y*phase.sx+z*phase.cx;
        ctx.fillStyle=G.spectrum[d.ink]; ctx.globalAlpha=d.opacity*(.65+.0038*depth);
        ctx.fillRect(px-r,py-r,2*r,2*r);
      }
      ctx.globalAlpha=1;
      glow(0,0,35,[[0,'#ffffff'],[.10,'#f4fcff'],[.23,'#c7e3ffe8'],[.43,'#8fbcff94'],[.7,'#a797ed33'],[1,'#7355ab00']]);
      ctx.rotate(-.19);
      for (let i=0;i<3;i++) {
        ctx.rotate(i===1?.92:i===2?1.08:0);
        const extent=i===0?48:25;
        const g=ctx.createLinearGradient(-extent,0,extent,0);
        g.addColorStop(0,'#60b6ff00');g.addColorStop(.48,'#d5f4ffcc');g.addColorStop(.52,'#ffe3ffcc');g.addColorStop(1,'#cd83ef00');
        ctx.fillStyle=g; ctx.beginPath();ctx.moveTo(-extent,0);ctx.lineTo(0,-1.1);ctx.lineTo(extent,0);ctx.lineTo(0,1.1);ctx.fill();
      }
      ctx.restore();
    }
    return {
      resize(w,h,dpr) {
        width=w;height=h;ratio=dpr;
        const pw=Math.max(1,Math.round(w*dpr)), ph=Math.max(1,Math.round(h*dpr));
        if (canvas.width!==pw) canvas.width=pw;
        if (canvas.height!==ph) canvas.height=ph;
      },
      draw(frame,net,quality) {
        if (!ctx) return;
        const c=frame.camera;
        ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
        ctx.save();ctx.translate(c.x,c.y);ctx.scale(c.scale,c.scale);
        ctx.globalCompositeOperation='lighter';
        for (const edge of net.edges) {
          ctx.lineWidth=(edge.selected?1.15:.82)/c.scale;
          ctx.strokeStyle=edge.selected?'#a3d9ffb8':'#93a7dc60';
          ctx.beginPath();ctx.moveTo(edge.a.x,edge.a.y);ctx.quadraticCurveTo(edge.cx,edge.cy,edge.b.x,edge.b.y);ctx.stroke();
          if (!frame.overview) {
            ctx.strokeStyle=edge.selected?'#c79beb65':'#ac8cc724';ctx.lineWidth=.66/c.scale;
            ctx.beginPath();ctx.moveTo(edge.a.x,edge.a.y);
            for (let j=1;j<=18;j++) { const p=G.onCurve(edge,j/18,6);ctx.lineTo(p.x,p.y);}
            ctx.stroke();
          }
        }
        for (const node of net.nodes.values()) {
          if (node.root) continue;
          const r=Math.max(4/c.scale,node.radius);
          glow(node.x,node.y,r*2.8,[[0,'#f4faff'],[.08,'#e1edff'],[.23,node.color+'ca'],[.5,node.color+'36'],[1,node.color+'00']]);
          ctx.beginPath();ctx.arc(node.x,node.y,r*.92,.32,5.54);ctx.strokeStyle=node.color+(node.stale?'70':'a0');
          ctx.lineWidth=.8/c.scale;ctx.stroke();
          if (node.selected) {ctx.beginPath();ctx.arc(node.x,node.y,r*1.6,0,Math.PI*2);ctx.strokeStyle='#d6d4f68a';ctx.stroke();}
        }
        if (net.root) drawCore(net.root,G.pose(frame.decorativeTime),c.scale,quality);
        visitPulses(frame,net,(x,y,a,color) => {
          ctx.globalAlpha=a; glow(x,y,Math.max(8,7/c.scale),[[0,'#ffffff'],[.22,color],[1,color+'00']]);
        });
        ctx.restore();
      }
    };
  }

  const lineVertex = `
    attribute vec3 ink;
    attribute float strength;
    uniform float sculpture; uniform float coreSize; uniform float exposure;
    varying vec4 light;
    void main() {
      vec4 wp = modelMatrix * vec4(position,1.0);
      vec3 offset=mat3(modelMatrix)*position/coreSize;
      float depth = clamp(offset.z/83.0,-1.0,1.0);
      vec3 split=mix(vec3(.55,.94,1.),vec3(1.,.63,.91),smoothstep(-47.,49.,offset.x+offset.y*.32));
      light = vec4(ink*mix(vec3(1.),split,sculpture*.48),strength*mix(1.0,(0.68+0.37*depth)*exposure,sculpture));
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const lightFragment = `varying vec4 light;
    void main() {gl_FragColor=vec4(light.rgb*light.a,light.a);}`;
  const pointVertex = `
    attribute vec3 ink; attribute float size; attribute float strength;
    uniform float scale; uniform float dpr; uniform float isDust; uniform float coreSize;
    varying vec4 light;
    void main() {
      vec4 wp=modelMatrix*vec4(position,1.0);
      float front=clamp(wp.z/(83.0*coreSize),-1.0,1.0);
      light=vec4(ink,strength*mix(1.0,0.72+0.32*front,isDust));
      float px=mix(max(22.4,size*scale),max(0.65,size*scale*coreSize),isDust);
      gl_PointSize=px*dpr; gl_Position=projectionMatrix*viewMatrix*wp;
    }`;
  const dustFragment = `
    varying vec4 light;
    void main() {
      vec2 p=abs(gl_PointCoord*2.0-1.0);
      float a=light.a*(1.0-smoothstep(.48,1.26,max(p.x,p.y)));
      gl_FragColor=vec4(light.rgb*a,a);
    }`;
  const nodeFragment = `
    varying vec4 light;
    void main() {
      vec2 p=gl_PointCoord*2.0-1.0; float r=length(p);
      float halo=.47*exp(-3.6*r)*(1.0-smoothstep(.6,1.0,r));
      float pearl=.92*exp(-64.0*r*r);
      float arc=max(0.0,1.0-abs(r-.33)*31.0)*(.34+.18*p.x);
      float selected=step(.99,light.a)*max(0.0,1.0-abs(r-.58)*31.0)*.43;
      float a=clamp((halo+pearl+selected+arc)*light.a,0.0,1.0);
      gl_FragColor=vec4(mix(light.rgb,vec3(.97,.99,1.0),pearl)*a,a);
    }`;
  const bloomVertex = `
    varying vec2 local;
    void main() {local=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
  const bloomFragment = `
    varying vec2 local; uniform float selectedRoot;
    float streak(vec2 p,vec2 axis,float reach,float width) {
      return exp(-abs(dot(p,axis))/reach-abs(dot(p,vec2(-axis.y,axis.x)))/width);
    }
    void main() {
      vec2 p=local;float r=length(p);
      vec3 ice=vec3(.33,.75,1.0);vec3 rose=vec3(.86,.48,.93);
      vec3 tint=mix(ice,rose,smoothstep(-40.0,55.0,p.x+.3*p.y));
      float rind=exp(-pow((r-71.0)/9.0,2.0))*(.092+selectedRoot*.073);
      float veil=.12*exp(-r/44.0);
      float outside=1.0-smoothstep(86.0,108.0,r);
      float iris=.72*exp(-r/11.4);
      float white=1.22*exp(-r*r/37.0);
      float rays=.55*streak(p,vec2(.982,-.189),17.0,.74)
                +.32*streak(p,vec2(.761,.649),11.0,.68)
                +.24*streak(p,vec2(-.285,.959),9.0,.65);
      vec3 light=(tint*(rind+veil)+mix(tint,vec3(.81,.90,1.0),.53)*iris
              +vec3(.99,.99,1.0)*(white+rays))*outside;
      gl_FragColor=vec4(light,clamp(max(max(light.r,light.g),light.b),0.0,1.0));
    }`;

  function makeGpuRenderer(T,canvas,model,context) {
    const renderer=new T.WebGLRenderer({canvas,context,antialias:true,alpha:true,premultipliedAlpha:true});
    let shaderFailed=false;
    renderer.debug.checkShaderErrors=true;
    renderer.debug.onShaderError=()=>{shaderFailed=true;};
    const scene=new T.Scene(), camera=new T.OrthographicCamera(0,1,0,1,.1,2000);
    camera.position.z=500;
    const sculpture=new T.Group(), body=new T.Group();
    sculpture.add(body);sculpture.scale.setScalar(G.coreScale);scene.add(sculpture);
    let width=0,height=0,ratio=1,network=null,edgeLines=null,neurons=null;
    const geometries=new Set(), materials=[];
    const scale={value:1},dpr={value:1},coreSize={value:G.coreScale},exposure={value:1};
    function shader(vertexShader,fragmentShader,uniforms={}) {
      const m=new T.ShaderMaterial({vertexShader,fragmentShader,uniforms,side:T.DoubleSide,
        depthWrite:false,depthTest:false,transparent:true,blending:T.CustomBlending,
        blendSrc:T.OneFactor,blendDst:T.OneFactor,blendEquation:T.AddEquation});
      materials.push(m);return m;
    }
    function geom(data) {
      const geo=new T.BufferGeometry();geometries.add(geo);
      for (const [key,arr] of Object.entries(data)) {
        const length=(key==='position'||key==='ink')?3:1;
        geo.setAttribute(key,new T.Float32BufferAttribute(arr,length));
      }
      return geo;
    }
    function object(parent,type,geometry,material,order) {
      const obj=new type(geometry,material);obj.renderOrder=order;
      obj.frustumCulled=false;parent.add(obj);return obj;
    }
    function drop(obj) {
      if (!obj) return;
      obj.removeFromParent();geometries.delete(obj.geometry);obj.geometry.dispose();
    }
    const coreInk=G.spectrum.map(rgb);
    const lineData={position:[],ink:[],strength:[]};
    function vertex(out,x,y,z,ink,strength) {
      out.position.push(x,y,z);out.ink.push(...ink);out.strength.push(strength);
    }
    for (const path of model.paths) {
      const arr=path.xyz,col=coreInk[path.ink];
      for (let i=3;i<arr.length;i+=3) {
        vertex(lineData,arr[i-3],arr[i-2],arr[i-1],col,path.opacity);
        vertex(lineData,arr[i],arr[i+1],arr[i+2],col,path.opacity);
      }
    }
    object(body,T.LineSegments,geom(lineData),shader(lineVertex,lightFragment,{sculpture:{value:1},coreSize,exposure}),3);
    const dustData={position:[],ink:[],strength:[],size:[]};
    for (const d of model.dust) {vertex(dustData,d.x,d.y,d.z,coreInk[d.ink],d.opacity);dustData.size.push(d.size);}
    const dust=object(body,T.Points,geom(dustData),shader(pointVertex,dustFragment,{scale,dpr,coreSize,isDust:{value:1}}),4);
    const plane=new T.PlaneGeometry(216,216);geometries.add(plane);
    const selectedRoot={value:0};
    object(sculpture,T.Mesh,plane,shader(bloomVertex,bloomFragment,{selectedRoot}),2);
    const edgeMat=shader(lineVertex,lightFragment,{sculpture:{value:0},coreSize,exposure});
    const nodeMat=shader(pointVertex,nodeFragment,{scale,dpr,coreSize,isDust:{value:0}});
    const pulseCapacity=16;
    const pulseGeometry=geom({position:new Float32Array(pulseCapacity*3),ink:new Float32Array(pulseCapacity*3),
      strength:new Float32Array(pulseCapacity),size:new Float32Array(pulseCapacity).fill(21)});
    pulseGeometry.setDrawRange(0,0);
    const pulses=object(scene,T.Points,pulseGeometry,nodeMat,5);
    let builtOverview;
    function setNetwork(net,overview) {
      network=net;builtOverview=overview;drop(edgeLines);drop(neurons);
      const lines={position:[],ink:[],strength:[]},points={position:[],ink:[],strength:[],size:[]};
      for (const edge of net.edges) {
        for (const separation of overview?[0]:[0,6]) {
          const col=separation ? [.72,.54,.82] : edge.selected?[.65,.87,1]:[.54,.62,.80];
          const opacity=separation?(edge.selected?.31:.13):(edge.selected?.76:.36);
          let prev=edge.a;
          for (let i=1;i<=20;i++) {
            const next=G.onCurve(edge,i/20,separation);
            vertex(lines,prev.x,prev.y,0,col,opacity);vertex(lines,next.x,next.y,0,col,opacity);prev=next;
          }
        }
      }
      for (const node of net.nodes.values()) {
        if (node.root) continue;
        vertex(points,node.x,node.y,0,rgb(node.color),node.selected?1:node.stale?.70:.90);
        points.size.push(node.radius*5.6);
      }
      edgeLines=object(scene,T.LineSegments,geom(lines),edgeMat,0);
      neurons=object(scene,T.Points,geom(points),nodeMat,1);
    }
    return {
      resize(w,h,pixelRatio) {
        width=w;height=h;ratio=pixelRatio;
        renderer.setDrawingBufferSize(Math.max(1,w),Math.max(1,h),ratio);
      },
      draw(frame,net,quality) {
        if (network!==net || frame.overview!==builtOverview) setNetwork(net,frame.overview);
        const c=frame.camera;scale.value=c.scale;dpr.value=ratio;
        exposure.value=Math.min(1.07,Math.max(.23,.67*c.scale*G.coreScale*ratio));
        camera.left=-c.x/c.scale;camera.right=(width-c.x)/c.scale;
        camera.top=-c.y/c.scale;camera.bottom=(height-c.y)/c.scale;camera.updateProjectionMatrix();
        sculpture.visible=Boolean(net.root);
        if (net.root) {
          selectedRoot.value=net.root.selected?1:0;
          sculpture.position.set(net.root.x,net.root.y,0);
          const p=G.pose(frame.decorativeTime);body.rotation.set(p.pitch,p.yaw,0,'XYZ');
          dust.geometry.setDrawRange(0,quality==='full'?model.dust.length:Math.floor(model.dust.length*.5));
        }
        const a=pulses.geometry.attributes;
        let count=0;
        visitPulses(frame,net,(x,y,opacity,color) => {
          if (count>=a.position.count) return;
          a.position.setXYZ(count,x,y,0);a.ink.setXYZ(count,...rgb(color));a.strength.setX(count,opacity*.94);count++;
        });
        if (count) {a.position.needsUpdate=true;a.ink.needsUpdate=true;a.strength.needsUpdate=true;}
        pulses.geometry.setDrawRange(0,count);renderer.render(scene,camera);
        // Three reports driver link failures through its hook. Let the render
        // finish its bookkeeping before the outer draw restores the 2D canvas.
        if (shaderFailed) throw new Error('Scene shader link failed');
      },
      dispose() {
        for (const g of geometries) g.dispose();
        for (const m of materials) m.dispose();
        renderer.dispose();
      }
    };
  }

  function create(canvas, {invalidate=()=>{}}={}) {
    const model=G.createSculpture(), software=makeCanvasRenderer(canvas,model);
    let gpu=null, gpuCanvas=null, gpuContext=null, dead=false, frames=0,quality='full';
    let width=0,height=0,ratio=1,slow=0,previousDraw=0,previousTime=null,averageInterval=0;
    let prevGraph,prevAgents,prevRoot,prevSelected,net;
    function resize(w,h,pixelRatio=1) {
      const nextW=Math.max(0,Number(w)||0),nextH=Math.max(0,Number(h)||0);
      const nextRatio=Math.min(1.5,Math.max(.5,Number(pixelRatio)||1));
      if (width===nextW && height===nextH && ratio===nextRatio) return;
      width=nextW;height=nextH;ratio=nextRatio;
      (gpu||software).resize(width,height,ratio);
    }
    function releaseGpu(lose) {
      if (gpuCanvas) gpuCanvas.removeEventListener('webglcontextlost',loseContext);
      if (gpu) gpu.dispose();
      if (lose && gpuContext && !gpuContext.isContextLost()) gpuContext.getExtension('WEBGL_lose_context')?.loseContext();
      gpu=null;gpuContext=null;gpuCanvas=null;
    }
    function fallback(lose) {
      if (gpuCanvas?.parentNode) gpuCanvas.replaceWith(canvas);
      releaseGpu(lose);software.resize(width,height,ratio);
    }
    function loseContext(event) {
      event.preventDefault();
      if (dead) return;
      fallback(false);invalidate();
    }
    import('./vendor/three-r170/three.module.min.js').then(T => {
      if (dead || !canvas.parentNode) return;
      gpuCanvas=canvas.cloneNode(true);
      const options={alpha:true,antialias:true,depth:false,stencil:false,premultipliedAlpha:true,powerPreference:'low-power'};
      gpuContext=gpuCanvas.getContext('webgl2',options);
      if (!gpuContext) {gpuCanvas=null;return;}
      gpu=makeGpuRenderer(T,gpuCanvas,model,gpuContext);
      gpu.resize(width,height,ratio);
      gpuCanvas.addEventListener('webglcontextlost',loseContext);
      canvas.replaceWith(gpuCanvas);software.resize(0,0,1);invalidate();
    }).catch(() => {if (!dead) fallback(true);});
    return {
      resize,
      draw(frame) {
        if (dead) return;
        resize(frame.width,frame.height,frame.pixelRatio);
        if (!width || !height || !(frame.camera.scale>0)) return;
        if (prevGraph!==frame.graph || prevAgents!==frame.agents || prevRoot!==frame.rootId || prevSelected!==frame.selectedAgentId) {
          net=G.buildNetwork(frame.graph,frame.agents,frame.rootId,frame.selectedAgentId);
          prevGraph=frame.graph;prevAgents=frame.agents;prevRoot=frame.rootId;prevSelected=frame.selectedAgentId;
        }
        const start=performance.now(),interval=start-previousDraw;
        try {(gpu||software).draw(frame,net,quality);}
        catch(error) {
          if (!gpu) throw error;
          fallback(true);software.draw(frame,net,quality);
        }
        const cost=performance.now()-start;
        if (previousTime!==null && frame.decorativeTime!==previousTime) {
          if (interval>10 && interval<150) averageInterval=averageInterval?averageInterval*.9+interval*.1:interval;
          slow=(cost>24 || (interval>58 && interval<150))?slow+1:Math.max(0,slow-2);
          if (slow>=18) quality='balanced';
        }
        previousDraw=start;previousTime=frame.decorativeTime;frames++;
      },
      getDiagnostics() {return {mode:gpu?'webgl2':'canvas2d',frames,quality,pixelRatio:ratio,
        fps:averageInterval?Math.round(1000/averageInterval):null};},
      dispose() {
        if (dead) return;
        dead=true;
        if (gpuCanvas?.parentNode) gpuCanvas.replaceWith(canvas);
        releaseGpu(true);
        software.resize(0,0,1);net=null;prevGraph=null;prevAgents=null;
      }
    };
  }
  window.AxonScene={create};
})();
