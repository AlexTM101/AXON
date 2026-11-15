// Standalone Chromium renderer check: node tests/scene-browser.cjs [preview-directory].
// Fixtures are synthetic and the loopback server serves only four allowlisted assets.
'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const web = path.resolve(__dirname,'../src/Axon.Desktop/Web');
const routes = ['/scene.js','/scene-geometry.js','/vendor/three-r170/three.module.min.js'];
const chrome = process.env.CHROME_PATH || path.join(process.env.ProgramFiles,'Google/Chrome/Application/chrome.exe');

function browserTest() {
  let renderer,invalidations=0,frame;
  const canvas=document.querySelector('canvas'), result=document.querySelector('pre');
  const scenario=new URLSearchParams(location.search).get('scenario');
  let webglRequests=0, nullResponses=0, rejectedPrograms=0;
  const get=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,...args) {
    if (type==='webgl2') {
      webglRequests++;
      if (scenario==='canvas2d') {nullResponses++;return null;}
    }
    return get.call(this,type,...args);
  };
  if (scenario==='failed-link') {
    const link=WebGL2RenderingContext.prototype.linkProgram;
    WebGL2RenderingContext.prototype.linkProgram=function(program) {
      // Remove the first actual fragment shader. The driver itself must reject
      // this program at link time, with its real status and driver log intact.
      if (rejectedPrograms===0) {
        const fragment=this.getAttachedShaders(program).find(s=>this.getShaderParameter(s,this.SHADER_TYPE)===this.FRAGMENT_SHADER);
        if (fragment) this.detachShader(program,fragment);
      }
      link.call(this,program);
      if (!this.getProgramParameter(program,this.LINK_STATUS)) rejectedPrograms++;
    };
  }
  const agents=[{id:'root',depth:0},{id:'worker',depth:1,state:'completed'}];
  frame={graph:{nodes:[{id:'root',x:0,y:0},{id:'worker',x:205,y:65}],edges:[{from:'root',to:'worker'}]},
    agents,rootId:'root',selectedAgentId:'worker',camera:{x:230,y:230,scale:1.2},width:540,height:460,pixelRatio:1,
    now:4000,decorativeTime:4000,pulses:[],overview:false,reducedMotion:true};
  renderer=window.AxonScene.create(canvas,{invalidate(){invalidations++;renderer.draw(frame);}});
  const active=()=>document.querySelector('canvas');
  const expected=scenario==='webgl2'?'webgl2':'canvas2d';
  function capture() {
    renderer.draw(frame);
    const copy=document.createElement('canvas');
    copy.width=frame.width;copy.height=frame.height;
    const ctx=copy.getContext('2d');
    ctx.fillStyle='#030508';ctx.fillRect(0,0,copy.width,copy.height);ctx.drawImage(active(),0,0);
    return {ctx,image:copy.toDataURL('image/png')};
  }
  function report() {
    try {
      const first=capture(),same=capture();
      const sample=(x,y)=>[...first.ctx.getImageData(x,y,1,1).data].slice(0,3);
      const center=sample(230,230),agent=sample(476,308),empty=sample(3,3);
      frame.decorativeTime+=4000;
      const moved=capture(), beforeLoss=renderer.getDiagnostics();
      const checks={mode:beforeLoss.mode===expected,webglAttempted:webglRequests>0,
        invalidated:scenario==='canvas2d'||invalidations>0,same:first.image===same.image,
        motion:moved.image!==first.image,root:center.every(n=>n>180),node:agent.every(n=>n>100),
        empty:empty.every(n=>n<15),attributes:active().id==='canvas'&&active().getAttribute('aria-label')==='Scene'};
      if (scenario==='canvas2d') checks.creationReturnedNull=nullResponses===1 && active()===canvas;
      if (scenario==='failed-link') checks.realLinkFailure=rejectedPrograms>0 && active()===canvas;
      frame.camera.scale=.60;
      const overview=capture(), pixels=overview.ctx.getImageData(150,150,160,160).data;
      let shadows=0, colored=0, clipped=0;
      for (let y=0;y<160;y++) for (let x=0;x<160;x++) {
        const r=Math.hypot(x-80,y-80);
        if (r<22 || r>68) continue;
        const i=(y*160+x)*4, hi=Math.max(pixels[i],pixels[i+1],pixels[i+2]);
        shadows+=hi<70;colored+=hi-Math.min(pixels[i],pixels[i+1],pixels[i+2])>18;clipped+=hi===255;
      }
      checks.overviewDetail=shadows>2000 && colored>300 && clipped<1500;
      frame.camera.scale=1.2;
      function finish() {
        try {
          const after=capture();
          checks.recovered=renderer.getDiagnostics().mode==='canvas2d';
          checks.fallbackPainted=after.ctx.getImageData(230,230,1,1).data[0]>180;
          frame.pixelRatio=4;renderer.draw(frame);checks.ratio=renderer.getDiagnostics().pixelRatio===1.5;
          frame.width=0;frame.height=0;renderer.draw(frame);
          renderer.dispose();renderer.dispose();
          result.textContent=JSON.stringify({checks,webglRequests,nullResponses,rejectedPrograms,center,agent,empty,shadows,colored,clipped,image:first.image});
        } catch (err) {result.textContent=JSON.stringify({error:String(err.stack)});}
      }
      if (expected==='webgl2' && beforeLoss.mode==='webgl2') {
        const gpu=active();
        gpu.addEventListener('webglcontextlost',()=>setTimeout(finish,0),{once:true});
        gpu.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
      } else finish();
    } catch (err) {result.textContent=JSON.stringify({error:String(err.stack)});}
  }
  renderer.draw(frame);
  function wait(attempt) {
    const ready=scenario==='canvas2d'?nullResponses>0:scenario==='failed-link'?rejectedPrograms>0:renderer.getDiagnostics().mode==='webgl2';
    if (ready || attempt===100) return report();
    setTimeout(()=>wait(attempt+1),50);
  }
  wait(0);
}

async function run() {
  const server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;
    if (route==='/') {
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'");
      res.setHeader('Content-Type','text/html');
      return res.end('<!doctype html><canvas id="canvas" aria-label="Scene"></canvas><pre></pre><script src="/scene-geometry.js"></script><script src="/scene.js"></script><script src="/fixture.js"></script>');
    }
    if (route==='/fixture.js') {res.setHeader('Content-Type','text/javascript');return res.end('('+browserTest.toString()+')()');}
    if (!routes.includes(route)) {res.writeHead(404);return res.end();}
    res.setHeader('Content-Type','text/javascript');fs.createReadStream(path.join(web,route)).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    for (const mode of ['webgl2','canvas2d','failed-link']) {
      const profile=fs.mkdtempSync(path.join(os.tmpdir(),'axon-render-test-'));
      try {
        const url='http://127.0.0.1:'+server.address().port+'/?scenario='+mode;
        const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--use-angle=swiftshader',
          '--enable-unsafe-swiftshader','--virtual-time-budget=10000','--user-data-dir='+profile,'--dump-dom',url],{windowsHide:true});
        let html='',errors='';child.stdout.on('data',d=>html+=d);child.stderr.on('data',d=>errors+=d);
        const timer=setTimeout(()=>child.kill(),45000);
        let code;
        try {code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
        finally {clearTimeout(timer);}
        assert.equal(code,0,errors.slice(-1200));
        const match=html.match(/<pre>([^<]+)<\/pre>/);assert.ok(match,'Browser did not return results. '+errors.slice(-800));
        const report=JSON.parse(match[1]);assert.ok(!report.error,report.error);
        if (process.argv[2]) {
          const output=path.join(path.resolve(process.argv[2]),'axon-render-'+mode+'.png');
          fs.writeFileSync(output,Buffer.from(report.image.split(',')[1],'base64'));
          console.log(output);
        }
        delete report.image; console.log(mode,report);
        assert.ok(Object.values(report.checks).every(Boolean),'Failed renderer checks');
      } finally {
        if (path.dirname(profile)===path.resolve(os.tmpdir()) && path.basename(profile).startsWith('axon-render-test-')) {
          fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
        }
      }
    }
  } finally {server.close();}
}
run().catch(err=>{console.error(err);process.exitCode=1;});
